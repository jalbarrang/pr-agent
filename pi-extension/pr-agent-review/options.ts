import { existsSync, readFileSync } from "node:fs"
import path from "node:path"

import { resolveBackend, venvPython, type Backend, type DiffMode, type ReviewCommand, type RunnerOptions } from "./runner.ts"

export const COMMANDS: ReviewCommand[] = ["review", "describe", "improve", "ask"]
export const MODES: DiffMode[] = ["working", "staged", "branch"]
export const BACKENDS: Backend[] = ["auto", "uv", "venv", "docker"]

/** Shape of `config.json`; every field is optional and unvalidated until resolved. */
export interface OptionsShape {
    backend?: unknown
    prAgentRoot?: unknown
    uvBinary?: unknown
    composeFile?: unknown
    apiBase?: unknown
    model?: unknown
    modelWeak?: unknown
    fallbackModels?: unknown
    effortModels?: unknown
    reasoningEffort?: unknown
    customModelMaxTokens?: unknown
    maxModelTokens?: unknown
    aiTimeout?: unknown
    env?: unknown
    maxDiffBytes?: unknown
}

/** Arguments accepted by the `pr_agent_review` tool and the `/review` command. */
export interface ReviewParams {
    command?: ReviewCommand
    mode?: DiffMode
    base?: string
    question?: string
    path?: string
}

function optionalString(value: unknown): string | undefined {
    return typeof value === "string" && value.trim() ? value.trim() : undefined
}

function stringList(value: unknown, fallback: string[]): string[] {
    if (Array.isArray(value)) {
        return value.map(String).filter(Boolean)
    }
    if (typeof value === "string" && value.trim()) {
        return value.split(",").map((item) => item.trim()).filter(Boolean)
    }
    return fallback
}

function positiveInt(value: unknown, fallback: number): number {
    const parsed = typeof value === "number" ? value : Number(value)
    return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback
}

/** Where the PR-Agent checkout passed to the backends came from. */
export type RootSource = "config" | "env" | "session" | "extension" | "fallback"

const ROOT_SOURCE_LABELS: Record<RootSource, string> = {
    config: "the config file",
    env: "the PR_AGENT_ROOT environment variable",
    session: "the session directory",
    extension: "the extension directory",
    fallback: "the fallback (neither the session nor the extension directory is inside a checkout)",
}

export type ResolvedOptions = RunnerOptions & { rootSource: RootSource }

/** A directory Pi can review with: it has the CLI entrypoint and the project metadata. */
export function isPrAgentCheckout(dir: string): boolean {
    return existsSync(path.join(dir, "pr_agent", "cli.py")) && existsSync(path.join(dir, "pyproject.toml"))
}

/** Walk up from `startDir` looking for a PR-Agent checkout (`pr_agent/cli.py`). */
export function findPrAgentRoot(startDir: string): string | undefined {
    let current = path.resolve(startDir)
    for (;;) {
        if (isPrAgentCheckout(current)) {
            return current
        }
        const parent = path.dirname(current)
        if (parent === current) {
            return undefined
        }
        current = parent
    }
}

/**
 * Resolve the extension options for one call. `prAgentRoot` is detected from the
 * session directory first, then from the extension's own location, so a
 * user-level extension works against any checkout without configuration.
 */
export function resolveOptions(raw: OptionsShape, cwd: string, bundledRoot?: string): ResolvedOptions {
    const configuredRoot = optionalString(raw.prAgentRoot)
    const envRoot = optionalString(process.env.PR_AGENT_ROOT)
    const sessionRoot = findPrAgentRoot(cwd)

    let prAgentRoot: string
    let rootSource: RootSource
    if (configuredRoot) {
        prAgentRoot = path.resolve(cwd, configuredRoot)
        rootSource = "config"
    } else if (envRoot) {
        prAgentRoot = path.resolve(cwd, envRoot)
        rootSource = "env"
    } else if (sessionRoot) {
        prAgentRoot = sessionRoot
        rootSource = "session"
    } else if (bundledRoot) {
        prAgentRoot = bundledRoot
        rootSource = "extension"
    } else {
        prAgentRoot = path.resolve(cwd)
        rootSource = "fallback"
    }

    const envBackend = optionalString(process.env.PR_AGENT_BACKEND)
    const backend = envBackend ?? optionalString(raw.backend)
    const composeFile = optionalString(raw.composeFile)

    return {
        rootSource,
        backend: backend && BACKENDS.includes(backend as Backend) ? (backend as Backend) : "auto",
        prAgentRoot,
        uvBinary: optionalString(raw.uvBinary) ?? "uv",
        composeFile: composeFile
            ? path.resolve(cwd, composeFile)
            : path.join(prAgentRoot, "docker", "opencode-local", "docker-compose.yml"),
        apiBase: optionalString(raw.apiBase) ?? "https://opencode.ai/inference/go/openai/v1",
        model: optionalString(raw.model) ?? "openai/deepseek-v4.1-flash",
        modelWeak: optionalString(raw.modelWeak) ?? "openai/glm-5.3-flash",
        fallbackModels: stringList(raw.fallbackModels, ["openai/glm-5.3-flash"]),
        effortModels: stringList(raw.effortModels, ["deepseek-v4.1-flash", "glm-5.3-flash"]),
        reasoningEffort: optionalString(raw.reasoningEffort) ?? "high",
        customModelMaxTokens: positiveInt(raw.customModelMaxTokens, 200_000),
        maxModelTokens: positiveInt(raw.maxModelTokens, 200_000),
        aiTimeout: positiveInt(raw.aiTimeout, 300),
        env: raw.env && typeof raw.env === "object" && !Array.isArray(raw.env)
            ? Object.fromEntries(Object.entries(raw.env).map(([key, value]) => [key, String(value)]))
            : {},
        maxDiffBytes: positiveInt(raw.maxDiffBytes, 8 * 1024 * 1024),
    }
}

/** Read `config.json`. A malformed file fails the extension load instead of silently using defaults. */
export function loadOptions(configPath: string): OptionsShape {
    if (!existsSync(configPath)) {
        return {}
    }
    const parsed: unknown = JSON.parse(readFileSync(configPath, "utf8"))
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error(`${configPath} must contain a JSON object of pr-agent-review options.`)
    }
    return parsed as OptionsShape
}

/**
 * The venv and uv backends run PR-Agent on the host, so credentials come from
 * the same gitignored secrets file the Docker deployment mounts.
 */
export function hasHostCredentials(options: RunnerOptions): boolean {
    if (process.env.OPENAI__KEY || options.env.OPENAI__KEY) {
        return true
    }
    return [
        path.join(options.prAgentRoot, "pr_agent", "settings_prod", ".secrets.toml"),
        path.join(options.prAgentRoot, "pr_agent", "settings", ".secrets.toml"),
    ].some((file) => existsSync(file))
}

/**
 * Fail before touching git or spawning a child when the resolved backend cannot
 * run, naming the checkout, where it came from, and the fix.
 */
export function requireReady(options: ResolvedOptions, configPath: string): void {
    const root = `"${options.prAgentRoot}" (from ${ROOT_SOURCE_LABELS[options.rootSource]})`
    const backend = resolveBackend(options)

    if (backend === "docker") {
        if (!existsSync(options.composeFile)) {
            throw new Error(
                `Compose file not found at "${options.composeFile}". Build or point the "composeFile" option at ` +
                "docker/opencode-local/docker-compose.yml in a PR-Agent checkout.",
            )
        }
        return
    }

    if (!isPrAgentCheckout(options.prAgentRoot)) {
        throw new Error(
            `No PR-Agent checkout at ${root}: pr_agent/cli.py and pyproject.toml are missing. ` +
            `Set "prAgentRoot" in ${configPath} or PR_AGENT_ROOT to a checkout, or install the extension inside one.`,
        )
    }

    if (!hasHostCredentials(options)) {
        throw new Error(
            `No PR-Agent model credentials for checkout ${root}; backend "${backend}". ` +
            "PR-Agent calls the model itself, so it needs its own key: create " +
            `"${path.join(options.prAgentRoot, "pr_agent", "settings_prod", ".secrets.toml")}", ` +
            "set OPENAI__KEY, or add it under the \"env\" option in " + configPath + ". " +
            "The extension does not reuse Pi's provider login.",
        )
    }
}

/** Where the model key for the child process comes from, without printing it. */
export function credentialSource(options: RunnerOptions): string {
    if (process.env.OPENAI__KEY) {
        return "OPENAI__KEY from the environment"
    }
    if (options.env.OPENAI__KEY) {
        return "OPENAI__KEY from the \"env\" option"
    }
    const file = [
        path.join(options.prAgentRoot, "pr_agent", "settings_prod", ".secrets.toml"),
        path.join(options.prAgentRoot, "pr_agent", "settings", ".secrets.toml"),
    ].find((candidate) => existsSync(candidate))
    return file ?? "none"
}

/** Short, secret-free summary appended to every failure so the cause is visible. */
export function describeEnvironment(options: ResolvedOptions, configPath: string): string {
    const backend = resolveBackend(options)
    const target = backend === "docker"
        ? `docker compose -f ${options.composeFile}`
        : backend === "uv"
            ? `${options.uvBinary} run --project ${options.prAgentRoot} python -m pr_agent.cli`
            : venvPython(options.prAgentRoot)
    const checkout = isPrAgentCheckout(options.prAgentRoot) ? "checkout" : "NOT a checkout"

    return [
        "pr_agent_review environment:",
        `  config: ${existsSync(configPath) ? configPath : `${configPath} (missing)`}`,
        `  prAgentRoot: ${options.prAgentRoot} (${ROOT_SOURCE_LABELS[options.rootSource]}, ${checkout})`,
        `  backend: ${backend} -> ${target}`,
        `  credentials: ${credentialSource(options)}`,
        `  endpoint: ${options.apiBase}`,
        `  models: ${options.model} / ${options.modelWeak}`,
        `  maxDiffBytes: ${options.maxDiffBytes}`,
    ].join("\n")
}

export interface ParsedCommand {
    input: ReviewParams
    extra: string
}

/**
 * `/review` with no arguments reviews the working tree. The first token can
 * select a scope or another command; branch mode reads the next token as base.
 */
export function parseCommand(raw: string): ParsedCommand {
    const text = raw.trim()
    if (!text) {
        return { input: { command: "review", mode: "working" }, extra: "" }
    }

    const [first, second, ...rest] = text.split(/\s+/)
    const tail = rest.join(" ")

    switch (first) {
        case "staged":
            return { input: { command: "review", mode: "staged" }, extra: [second, ...rest].filter(Boolean).join(" ") }
        case "working":
            return { input: { command: "review", mode: "working" }, extra: [second, ...rest].filter(Boolean).join(" ") }
        case "branch": {
            const base = second && !second.includes("=") ? second : undefined
            return {
                input: { command: "review", mode: "branch", ...(base ? { base } : {}) },
                extra: base ? tail : [second, ...rest].filter(Boolean).join(" "),
            }
        }
        case "describe":
            return {
                input: { command: "describe", mode: "working" },
                extra: [second, ...rest].filter(Boolean).join(" "),
            }
        case "improve":
            return {
                input: { command: "improve", mode: "working" },
                extra: [second, ...rest].filter(Boolean).join(" "),
            }
        case "ask":
            return {
                input: {
                    command: "ask",
                    mode: "working",
                    question: [second, ...rest].filter(Boolean).join(" ") || "Summarize the risks in these changes.",
                },
                extra: "",
            }
        default:
            return { input: { command: "review", mode: "working" }, extra: text }
    }
}
