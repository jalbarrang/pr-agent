import { execFile } from "node:child_process"
import { existsSync } from "node:fs"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

export type ReviewCommand = "review" | "describe" | "improve" | "ask"
export type DiffMode = "working" | "staged" | "branch"

export type Backend = "auto" | "uv" | "venv" | "docker"

export interface RunnerOptions {
    /** "auto" prefers the project venv, then uv; "docker" uses the built CLI image. */
    backend: Backend
    /** PR-Agent checkout used by the uv backend and to locate the compose file. */
    prAgentRoot: string
    /** uv executable (or absolute path) for the uv backend. */
    uvBinary: string
    composeFile: string
    apiBase: string
    model: string
    modelWeak: string
    fallbackModels: string[]
    effortModels: string[]
    reasoningEffort: string
    customModelMaxTokens: number
    maxModelTokens: number
    aiTimeout: number
    /** Extra environment variables for the child process (highest precedence). */
    env: Record<string, string>
    /** Refuse diffs larger than this to avoid pushing megabytes through the prompt. */
    maxDiffBytes: number
}

export interface ReviewInput {
    dir: string
    command: ReviewCommand
    mode: DiffMode
    base?: string
    question?: string
    signal?: AbortSignal
}

interface ExecResult {
    stdout: string
    stderr: string
    code: number
}

function exec(command: string, args: string[], options: {
    cwd?: string
    env?: NodeJS.ProcessEnv
    stdin?: string
    signal?: AbortSignal
}): Promise<ExecResult> {
    return new Promise((resolve, reject) => {
        const child = execFile(
            command,
            args,
            {
                cwd: options.cwd,
                env: options.env,
                windowsHide: true,
                maxBuffer: 64 * 1024 * 1024,
            },
            (error, stdout, stderr) => {
                const code = typeof (error as { code?: unknown } | null)?.code === "number"
                    ? (error as { code: number }).code
                    : error
                        ? 1
                        : 0
                resolve({ stdout, stderr, code })
            },
        )

        const abort = () => child.kill()
        if (options.signal?.aborted) {
            abort()
        }
        options.signal?.addEventListener("abort", abort, { once: true })
        child.on("close", () => options.signal?.removeEventListener("abort", abort))

        child.on("error", (error) => reject(error))
        if (options.stdin !== undefined) {
            // A cancelled child stops reading stdin, so EPIPE must not go unhandled.
            child.stdin?.on("error", () => {})
            child.stdin?.end(options.stdin, "utf8")
        }
    })
}

/** `git diff --no-index` needs the platform null device to emit a new-file patch. */
const NULL_DEVICE = process.platform === "win32" ? "NUL" : "/dev/null"

async function git(args: string[], cwd: string, signal?: AbortSignal): Promise<ExecResult> {
    return exec("git", ["-c", "core.quotepath=false", ...args], { cwd, signal })
}

/** Resolve the repository root for an arbitrary directory inside a checkout. */
export async function resolveRepoRoot(dir: string, signal?: AbortSignal): Promise<string> {
    const result = await git(["rev-parse", "--show-toplevel"], dir, signal)
    if (result.code !== 0) {
        throw new Error(`Not a git repository: ${dir}\n${result.stderr.trim()}`)
    }
    return result.stdout.trim()
}

async function hasRef(root: string, ref: string, signal?: AbortSignal): Promise<boolean> {
    const result = await git(["rev-parse", "--verify", "--quiet", ref], root, signal)
    return result.code === 0
}

export async function defaultBase(root: string, signal?: AbortSignal): Promise<string> {
    const originHead = await git(["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], root, signal)
    if (originHead.code === 0 && originHead.stdout.trim()) {
        return originHead.stdout.trim()
    }
    for (const branch of ["main", "master"]) {
        if (await hasRef(root, `refs/heads/${branch}`, signal)) {
            return branch
        }
    }
    throw new Error("Could not detect a base branch. Pass `base` (for example \"main\").")
}

/** Unified diff for the requested scope, including untracked files in working mode. */
export async function buildDiff(
    root: string,
    mode: DiffMode,
    base?: string,
    signal?: AbortSignal,
): Promise<string> {
    let head = ""
    if (mode === "working") {
        const result = await git(["diff", "--no-color", "--no-ext-diff", "HEAD", "--"], root, signal)
        if (result.code === 0) {
            head = result.stdout
        } else {
            // Unborn HEAD: fall back to index + working tree.
            const unstaged = await git(["diff", "--no-color", "--no-ext-diff"], root, signal)
            const staged = await git(["diff", "--no-color", "--no-ext-diff", "--cached"], root, signal)
            head = staged.stdout + unstaged.stdout
        }
    } else if (mode === "staged") {
        head = (await git(["diff", "--no-color", "--no-ext-diff", "--cached"], root, signal)).stdout
    } else {
        const target = base ?? (await defaultBase(root, signal))
        const result = await git(["diff", "--no-color", "--no-ext-diff", `${target}...HEAD`], root, signal)
        if (result.code !== 0) {
            throw new Error(`Could not diff against "${target}":\n${result.stderr.trim()}`)
        }
        head = result.stdout
    }

    const parts = head ? [head] : []

    if (mode === "working") {
        const listed = await git(["ls-files", "--others", "--exclude-standard"], root, signal)
        const untracked = listed.stdout.split("\n").map((line) => line.trim()).filter(Boolean).slice(0, 100)
        for (const file of untracked) {
            // Exit code 1 means "differences found", which is the normal case here.
            const patch = await git(["diff", "--no-color", "--no-index", "--", NULL_DEVICE, file], root, signal)
            if (patch.stdout) {
                parts.push(patch.stdout)
            } else if (patch.code !== 0 && patch.code !== 1) {
                throw new Error(`Could not read untracked file "${file}":\n${patch.stderr.trim()}`)
            }
        }
    }

    return parts.join("\n")
}

function childEnv(options: RunnerOptions): NodeJS.ProcessEnv {
    return {
        ...process.env,
        OPENAI__API_BASE: options.apiBase,
        CONFIG__MODEL: options.model,
        CONFIG__MODEL_WEAK: options.modelWeak,
        CONFIG__FALLBACK_MODELS: JSON.stringify(options.fallbackModels),
        CONFIG__ADDITIONAL_REASONING_EFFORT_MODELS: JSON.stringify(options.effortModels),
        CONFIG__REASONING_EFFORT: options.reasoningEffort,
        CONFIG__CUSTOM_MODEL_MAX_TOKENS: String(options.customModelMaxTokens),
        CONFIG__MAX_MODEL_TOKENS: String(options.maxModelTokens),
        CONFIG__AI_TIMEOUT: String(options.aiTimeout),
        ...options.env,
    }
}

function cliArgs(input: ReviewInput, outputPath: string): string[] {
    const args = ["--stdin", "--output", outputPath, input.command]
    if (input.command === "ask") {
        if (!input.question?.trim()) {
            throw new Error("`question` is required when command is \"ask\".")
        }
        args.push(input.question)
    }
    return args
}

function uvArgs(input: ReviewInput, root: string, outputPath: string): string[] {
    // `uv run` syncs the project venv on first use and runs it from any directory.
    return [
        "run",
        "--project", root,
        "python", "-m", "pr_agent.cli",
        ...cliArgs(input, outputPath),
    ]
}

/** Interpreter created by `uv sync` in the PR-Agent checkout. */
export function venvPython(root: string): string {
    return process.platform === "win32"
        ? join(root, ".venv", "Scripts", "python.exe")
        : join(root, ".venv", "bin", "python")
}

function venvArgs(input: ReviewInput, outputPath: string): string[] {
    return ["-m", "pr_agent.cli", ...cliArgs(input, outputPath)]
}

function resolveBackend(options: RunnerOptions): Exclude<Backend, "auto"> {
    if (options.backend !== "auto") {
        return options.backend
    }
    return existsSync(venvPython(options.prAgentRoot)) ? "venv" : "uv"
}

function dockerArgs(input: ReviewInput, options: RunnerOptions, repo: string, outDir: string): string[] {
    const env = childEnv(options)
    // Pass names only: compose copies the value from this process's environment,
    // so credentials stay out of the compose command line.
    const envFlags = Object.keys(env)
        .filter((key) => key.startsWith("OPENAI__") || key.startsWith("CONFIG__") || key.startsWith("LITELLM__"))
        .flatMap((key) => ["-e", key])

    return [
        "compose",
        "-f", options.composeFile,
        "--profile", "cli",
        "run", "--rm", "--no-deps", "-T",
        "-v", `${repo}:/repo`,
        "-v", `${outDir}:/out`,
        "-w", "/repo",
        "--entrypoint", "python",
        ...envFlags,
        "pr-agent-cli",
        "/app/pr_agent/cli.py",
        ...cliArgs(input, "/out/result.md"),
    ]
}

export interface ReviewResult {
    markdown: string
    stderr: string
}

/**
 * Run PR-Agent's plain-diff mode against a local checkout and return the
 * markdown it writes to stdout.
 */
export async function reviewLocal(input: ReviewInput, options: RunnerOptions): Promise<ReviewResult> {
    if (input.signal?.aborted) {
        throw new Error("PR-Agent review was cancelled.")
    }

    const repo = await resolveRepoRoot(input.dir, input.signal)
    const diff = await buildDiff(repo, input.mode, input.base, input.signal)

    if (!diff.trim()) {
        return {
            markdown: "No changes found for the requested scope.",
            stderr: "",
        }
    }

    const size = Buffer.byteLength(diff, "utf8")
    if (size > options.maxDiffBytes) {
        throw new Error(
            `Diff is ${(size / 1024 / 1024).toFixed(1)} MiB, above the ${(options.maxDiffBytes / 1024 / 1024).toFixed(1)} MiB limit. ` +
            "Use mode \"staged\", a narrower base branch, or raise maxDiffBytes.",
        )
    }

    const outDir = await mkdtemp(join(tmpdir(), "pr-agent-review-"))
    const hostOutput = join(outDir, "result.md")

    try {
        const backend = resolveBackend(options)
        const command = backend === "docker"
            ? "docker"
            : backend === "uv"
                ? options.uvBinary
                : venvPython(options.prAgentRoot)
        const args = backend === "docker"
            ? dockerArgs(input, options, repo, outDir)
            : backend === "uv"
                ? uvArgs(input, options.prAgentRoot, hostOutput)
                : venvArgs(input, hostOutput)

        const result = await exec(command, args, {
            cwd: repo,
            env: childEnv(options),
            stdin: diff,
            signal: input.signal,
        })

        if (input.signal?.aborted) {
            throw new Error("PR-Agent review was cancelled.")
        }

        if (result.code !== 0) {
            const tail = (result.stderr || result.stdout).trim().split("\n").slice(-25).join("\n")
            throw new Error(`PR-Agent exited with code ${result.code}:\n${tail}`)
        }

        // PR-Agent's logger writes to stdout, so the report is read back from
        // --output instead of being parsed out of the log stream.
        const markdown = await readFile(hostOutput, "utf8").catch(() => "")
        if (!markdown.trim()) {
            const tail = result.stderr.trim().split("\n").slice(-10).join("\n")
            throw new Error(`PR-Agent produced no output.\n${tail}`)
        }

        return { markdown: markdown.trim(), stderr: result.stderr }
    } finally {
        await rm(outDir, { recursive: true, force: true })
    }
}
