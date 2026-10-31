import { existsSync, readFileSync } from "node:fs"
import path from "node:path"

import type { Backend, DiffMode, ReviewCommand, RunnerOptions } from "./runner.ts"

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

/** Walk up from `startDir` looking for a PR-Agent checkout (`pr_agent/cli.py`). */
export function findPrAgentRoot(startDir: string): string | undefined {
    let current = path.resolve(startDir)
    for (;;) {
        if (existsSync(path.join(current, "pr_agent", "cli.py")) && existsSync(path.join(current, "pyproject.toml"))) {
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
export function resolveOptions(raw: OptionsShape, cwd: string, bundledRoot?: string): RunnerOptions {
    const configuredRoot = optionalString(raw.prAgentRoot) ?? optionalString(process.env.PR_AGENT_ROOT)
    const prAgentRoot = configuredRoot
        ? path.resolve(cwd, configuredRoot)
        : (findPrAgentRoot(cwd) ?? bundledRoot ?? path.resolve(cwd))

    const envBackend = optionalString(process.env.PR_AGENT_BACKEND)
    const backend = envBackend ?? optionalString(raw.backend)
    const composeFile = optionalString(raw.composeFile)

    return {
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
