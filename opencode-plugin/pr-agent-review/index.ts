import { existsSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

import { Plugin } from "@opencode/plugin"

import { reviewLocal, type Backend, type DiffMode, type ReviewCommand, type RunnerOptions } from "./runner.ts"

const here = path.dirname(fileURLToPath(import.meta.url))
const defaultRoot = path.resolve(here, "..", "..")

const COMMANDS: ReviewCommand[] = ["review", "describe", "improve", "ask"]
const MODES: DiffMode[] = ["working", "staged", "branch"]
const BACKENDS: Backend[] = ["auto", "uv", "venv", "docker"]

interface PluginOptionsShape {
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

interface ResolvedOptions extends RunnerOptions {
    prAgentRoot: string
    composeFile: string
}

interface ToolInput {
    command?: ReviewCommand
    mode?: DiffMode
    base?: string
    question?: string
    path?: string
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

export function resolveOptions(raw: PluginOptionsShape = {}): ResolvedOptions {
    const prAgentRoot = path.resolve(
        typeof raw.prAgentRoot === "string" && raw.prAgentRoot ? raw.prAgentRoot : defaultRoot,
    )
    const backend = typeof raw.backend === "string" && BACKENDS.includes(raw.backend as Backend)
        ? (raw.backend as Backend)
        : "auto"

    return {
        backend,
        prAgentRoot,
        uvBinary: typeof raw.uvBinary === "string" && raw.uvBinary ? raw.uvBinary : "uv",
        composeFile: typeof raw.composeFile === "string" && raw.composeFile
            ? path.resolve(raw.composeFile)
            : path.join(prAgentRoot, "docker", "opencode-local", "docker-compose.yml"),
        apiBase: typeof raw.apiBase === "string" && raw.apiBase
            ? raw.apiBase
            : "https://opencode.ai/inference/go/openai/v1",
        model: typeof raw.model === "string" && raw.model ? raw.model : "openai/deepseek-v4.1-flash",
        modelWeak: typeof raw.modelWeak === "string" && raw.modelWeak ? raw.modelWeak : "openai/glm-5.3-flash",
        fallbackModels: stringList(raw.fallbackModels, ["openai/glm-5.3-flash"]),
        effortModels: stringList(raw.effortModels, ["deepseek-v4.1-flash", "glm-5.3-flash"]),
        reasoningEffort: typeof raw.reasoningEffort === "string" && raw.reasoningEffort
            ? raw.reasoningEffort
            : "high",
        customModelMaxTokens: positiveInt(raw.customModelMaxTokens, 200_000),
        maxModelTokens: positiveInt(raw.maxModelTokens, 200_000),
        aiTimeout: positiveInt(raw.aiTimeout, 300),
        env: raw.env && typeof raw.env === "object" && !Array.isArray(raw.env)
            ? Object.fromEntries(Object.entries(raw.env).map(([key, value]) => [key, String(value)]))
            : {},
        maxDiffBytes: positiveInt(raw.maxDiffBytes, 8 * 1024 * 1024),
    }
}

/**
 * The uv backend runs the Python project on the host, so credentials come from
 * the same gitignored secrets file the Docker deployment mounts.
 */
function hasHostCredentials(options: ResolvedOptions): boolean {
    if (process.env.OPENAI__KEY || options.env.OPENAI__KEY) {
        return true
    }
    return [
        path.join(options.prAgentRoot, "pr_agent", "settings_prod", ".secrets.toml"),
        path.join(options.prAgentRoot, "pr_agent", "settings", ".secrets.toml"),
    ].some((file) => existsSync(file))
}

interface ParsedCommand {
    input: ToolInput
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
            return { input: { command: "review", mode: "staged" }, extra: tail }
        case "working":
            return { input: { command: "review", mode: "working" }, extra: tail }
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

const TOOL_DESCRIPTION = [
    "Run PR-Agent (the review engine in this repository) on local git changes and return its markdown.",
    "Use this to review code before committing, explain a branch diff, propose improvements, or ask a question about a diff.",
    "Modes: \"working\" = uncommitted tracked changes plus untracked files; \"staged\" = index only;",
    "\"branch\" = committed changes on HEAD against a base branch (defaults to origin/HEAD, main, or master).",
    "Commands: \"review\" (findings), \"describe\" (PR description), \"improve\" (code suggestions), \"ask\" (requires question).",
].join(" ")

export default Plugin.define({
    id: "pr-agent-review",
    async setup(ctx) {
        const options = resolveOptions(ctx.options as PluginOptionsShape)
        const directory = ctx.location.directory

        await ctx.tool.transform((editor) => {
            editor.add({
                name: "pr_agent_review",
                description: TOOL_DESCRIPTION,
                input: {
                    type: "object",
                    properties: {
                        command: {
                            type: "string",
                            enum: COMMANDS,
                            description: "PR-Agent command to run. Defaults to review.",
                        },
                        mode: {
                            type: "string",
                            enum: MODES,
                            description: "Which changes to review. Defaults to working.",
                        },
                        base: {
                            type: "string",
                            description: "Base branch for branch mode, for example main.",
                        },
                        question: {
                            type: "string",
                            description: "Question to answer. Required when command is ask.",
                        },
                        path: {
                            type: "string",
                            description: "Repository directory, relative to the current location. Defaults to the current location.",
                        },
                    },
                    additionalProperties: false,
                },
                execute: async (raw, context) => {
                    const input = raw as ToolInput
                    const command = input.command ?? "review"
                    const mode = input.mode ?? "working"

                    if (!COMMANDS.includes(command)) {
                        throw new Error(`Unsupported command "${command}". Use one of: ${COMMANDS.join(", ")}.`)
                    }
                    if (!MODES.includes(mode)) {
                        throw new Error(`Unsupported mode "${mode}". Use one of: ${MODES.join(", ")}.`)
                    }
                    if (options.backend !== "docker" && !hasHostCredentials(options)) {
                        throw new Error(
                            "No credentials for the host backend. Copy docker/opencode-local/secrets/.secrets.toml " +
                            `to ${path.join(options.prAgentRoot, "pr_agent", "settings_prod", ".secrets.toml")}, ` +
                            "set OPENAI__KEY, or switch the plugin option backend to \"docker\".",
                        )
                    }

                    await context.progress({ status: `pr-agent ${command} (${mode})` })

                    const result = await reviewLocal(
                        {
                            dir: input.path ? path.resolve(directory, input.path) : directory,
                            command,
                            mode,
                            base: input.base,
                            question: input.question,
                            signal: context.signal,
                        },
                        options,
                    )

                    return {
                        content: result.markdown,
                        metadata: { command, mode },
                    }
                },
            })
        })

        await ctx.command.transform((editor) => {
            editor.add({
                name: "review",
                description: "Review local git changes with PR-Agent. Args: [working|staged|branch <base>|describe|improve|ask <question>]",
                execute: async ({ sessionID, prompt, delivery }) => {
                    const { input, extra } = parseCommand(prompt.text ?? "")
                    const text = [
                        `Call the \`pr_agent_review\` tool exactly once with ${JSON.stringify(input)}.`,
                        "Then present its markdown report to me, preserving its structure.",
                        extra ? `Additional focus: ${extra}` : "",
                    ].filter(Boolean).join("\n")

                    await ctx.session.prompt({ ...prompt, sessionID, text, delivery })
                },
            })
        })
    },
})
