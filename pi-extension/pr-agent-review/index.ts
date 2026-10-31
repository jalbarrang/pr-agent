import path from "node:path"
import { fileURLToPath } from "node:url"

import { StringEnum } from "@earendil-works/pi-ai"
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { Type } from "typebox"

import {
    COMMANDS,
    MODES,
    describeEnvironment,
    findPrAgentRoot,
    loadOptions,
    parseCommand,
    requireReady,
    resolveOptions,
    type ReviewParams,
} from "./options.ts"
import { resolveBackend, reviewLocal } from "./runner.ts"

const here = path.dirname(fileURLToPath(import.meta.url))
/** PR-Agent checkout containing this extension, when installed from one. */
const bundledRoot = findPrAgentRoot(here)

const TOOL_DESCRIPTION = [
    "Run PR-Agent (the review engine in this repository) on local git changes and return its markdown.",
    "Use this to review code before committing, explain a branch diff, propose improvements, or ask a question about a diff.",
    "Modes: \"working\" = uncommitted tracked changes plus untracked files; \"staged\" = index only;",
    "\"branch\" = committed changes on HEAD against a base branch (defaults to origin/HEAD, main, or master).",
    "Commands: \"review\" (findings), \"describe\" (PR description), \"improve\" (code suggestions), \"ask\" (requires question).",
].join(" ")

const ReviewParameters = Type.Object({
    command: Type.Optional(StringEnum(COMMANDS, {
        description: "PR-Agent command to run. Defaults to review.",
    })),
    mode: Type.Optional(StringEnum(MODES, {
        description: "Which changes to review. Defaults to working.",
    })),
    base: Type.Optional(Type.String({
        description: "Base branch for branch mode, for example main.",
    })),
    question: Type.Optional(Type.String({
        description: "Question to answer. Required when command is ask.",
    })),
    path: Type.Optional(Type.String({
        description: "Repository directory, relative to the current location. Defaults to the current location.",
    })),
})

export default function prAgentReview(pi: ExtensionAPI) {
    const configPath = process.env.PR_AGENT_CONFIG?.trim() || path.join(here, "config.json")
    const configured = loadOptions(configPath)

    pi.registerTool({
        name: "pr_agent_review",
        label: "PR-Agent Review",
        description: TOOL_DESCRIPTION,
        promptSnippet: "Review local git changes with PR-Agent and return its markdown report",
        promptGuidelines: [
            "Use pr_agent_review when the user asks for a review, PR description, or improvement suggestions on local changes.",
        ],
        parameters: ReviewParameters,
        async execute(_toolCallId, params, signal, onUpdate, ctx) {
            const input = params as ReviewParams
            const command = input.command ?? "review"
            const mode = input.mode ?? "working"

            if (!COMMANDS.includes(command)) {
                throw new Error(`Unsupported command "${command}". Use one of: ${COMMANDS.join(", ")}.`)
            }
            if (!MODES.includes(mode)) {
                throw new Error(`Unsupported mode "${mode}". Use one of: ${MODES.join(", ")}.`)
            }

            const options = resolveOptions(configured, ctx.cwd, bundledRoot)
            try {
                requireReady(options, configPath)
            } catch (error) {
                throw new Error(`${error instanceof Error ? error.message : String(error)}\n\n${describeEnvironment(options, configPath)}`)
            }
            const backend = resolveBackend(options)

            onUpdate?.({
                content: [{ type: "text", text: `Running pr-agent ${command} (${mode}) via ${backend}...` }],
                details: { command, mode, backend },
            })

            const result = await reviewLocal(
                {
                    dir: input.path ? path.resolve(ctx.cwd, input.path) : ctx.cwd,
                    command,
                    mode,
                    base: input.base,
                    question: input.question,
                    signal,
                },
                options,
            ).catch((error: unknown) => {
                const message = error instanceof Error ? error.message : String(error)
                throw new Error(`${message}\n\n${describeEnvironment(options, configPath)}`)
            })

            return {
                content: [{ type: "text", text: result.markdown }],
                details: {
                    command,
                    mode,
                    backend: result.backend,
                    repo: result.repo,
                    diffBytes: result.diffBytes,
                },
            }
        },
    })

    pi.registerCommand("review", {
        description: "Review local git changes with PR-Agent. Args: [working|staged|branch <base>|describe|improve|ask <question>]",
        getArgumentCompletions: (prefix) => {
            const items = [...MODES, ...COMMANDS.filter((command) => command !== "review")].map((value) => ({
                value,
                label: value,
            }))
            return items.filter((item) => item.value.startsWith(prefix))
        },
        handler: async (args) => {
            const { input, extra } = parseCommand(args)
            const text = [
                `Call the \`pr_agent_review\` tool exactly once with ${JSON.stringify(input)}.`,
                "Then present its markdown report to me, preserving its structure.",
                extra ? `Additional focus: ${extra}` : "",
            ].filter(Boolean).join("\n")

            pi.sendUserMessage(text, { deliverAs: "followUp" })
        },
    })
}
