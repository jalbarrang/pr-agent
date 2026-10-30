# pr-agent-review (OpenCode V2 plugin)

Adds one tool, `pr_agent_review`, that runs PR-Agent's review engine on local git changes and returns the
markdown report to the agent. No PR URL, no hosting token, and no webhook server involved.

## Activation

The plugin is registered in `opencode.jsonc` at the repository root:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    {
      "package": "./opencode-plugin/pr-agent-review",
      "options": { "backend": "auto" }
    }
  ]
}
```

After OpenCode reloads, the tool is available to the agent.

## Usage

Ask naturally, or call the tool explicitly:

| Intent | Arguments |
| --- | --- |
| Review uncommitted work | `{ "command": "review", "mode": "working" }` |
| Review only staged changes | `{ "command": "review", "mode": "staged" }` |
| Review a branch against main | `{ "command": "review", "mode": "branch", "base": "main" }` |
| Write a PR description | `{ "command": "describe", "mode": "branch", "base": "main" }` |
| Suggest improvements | `{ "command": "improve", "mode": "staged" }` |
| Ask about the diff | `{ "command": "ask", "mode": "working", "question": "..." }` |

`path` selects a repository other than the current location (absolute or relative).

`working` includes untracked files, `staged` covers the index only, and `branch` diffs `base...HEAD`
(default base: `origin/HEAD`, then `main`, then `master`).

## Slash command

`/review` submits a prompt that calls the same tool:

| Command | Scope |
| --- | --- |
| `/review` | working tree (tracked + untracked) |
| `/review staged` | index only |
| `/review branch` | `HEAD` vs the detected base branch |
| `/review branch main` | `HEAD` vs `main` |
| `/review describe` | write a PR description |
| `/review improve` | suggest improvements |
| `/review ask <question>` | answer a question about the diff |
| `/review <anything else>` | review the working tree, text appended as additional focus |

Commands are registered at plugin load, so restart OpenCode (or the background service) after changing
the plugin for `/review` to appear.

## Backends

| Value | How it runs | Requirements |
| --- | --- | --- |
| `auto` (default) | `venv` if `<root>/.venv` exists, else `uv` | — |
| `venv` | `<root>/.venv/.../python -m pr_agent.cli` | `uv sync` has run once |
| `uv` | `uv run --project <root> python -m pr_agent.cli` | uv >= 0.13.5 (see `tool.uv.required-version`) |
| `docker` | `docker compose run pr-agent-cli` | the `opencode-cli` image from `docker/opencode-local` |

`auto` picks the synced venv, so runs take seconds. If the venv is missing it falls back to `uv`, which
syncs on first use.

## Credentials

Host backends (`venv`, `uv`) read the same TOML file the Docker deployment mounts:

```text
pr_agent/settings_prod/.secrets.toml
```

Copy it from `docker/opencode-local/secrets/.secrets.toml` if it is missing. It is gitignored and holds:

```toml
[openai]
key = "oc_sk_..."
[litellm]
extra_headers = '{"User-Agent": "pr-agent/1.0", "x-opencode-session": "ses-pr-agent-local"}'
```

You can also set `OPENAI__KEY` in the environment (or through `options.env`) instead. The `docker`
backend ignores this and uses its mounted copy.

## Options

| Option | Default | Meaning |
| --- | --- | --- |
| `backend` | `auto` | `auto`, `venv`, `uv`, or `docker` |
| `prAgentRoot` | two levels above the plugin | PR-Agent checkout |
| `uvBinary` | `uv` | uv executable for the `uv` backend |
| `composeFile` | `<root>/docker/opencode-local/docker-compose.yml` | compose file for `docker` |
| `apiBase` | `https://opencode.ai/inference/go/openai/v1` | OpenAI-compatible endpoint |
| `model` | `openai/deepseek-v4.1-flash` | primary model |
| `modelWeak` | `openai/glm-5.3-flash` | quick researcher (`ask`, `describe`) |
| `fallbackModels` | `["openai/glm-5.3-flash"]` | retry targets |
| `effortModels` | `["deepseek-v4.1-flash", "glm-5.3-flash"]` | models that accept `reasoning_effort` |
| `reasoningEffort` | `high` | both models support `low`, `high`, `max` |
| `customModelMaxTokens` | `200000` | required: neither model is in PR-Agent's table |
| `maxModelTokens` | `200000` | effective prompt budget |
| `aiTimeout` | `300` | seconds per model call |
| `env` | `{}` | extra child environment variables |
| `maxDiffBytes` | `8388608` | refuse larger diffs |

## How it works

1. Resolves the repository root with `git rev-parse --show-toplevel`.
2. Builds a unified diff (including untracked files in `working` mode).
3. Pipes it to `pr_agent.cli --stdin --output <temp file> <command>`.
4. Reads the report back from the temp file and returns it as tool content.

The temp file matters: PR-Agent's logger writes to stdout, so parsing stdout would mix logs into the
report. `--output` gives clean markdown.

## Limits

- Plain-diff mode cannot fetch repository files, so `repo_context_files` (e.g. `AGENTS.md`) is skipped.
  Use PR-Agent's `local` git provider or a hosted PR when you need that context.
- No inline comments or hosted publishing; the report is returned as text.
- Binary files are skipped by PR-Agent.
- Cancelling the tool call aborts the child process.
- Diffs above `maxDiffBytes` are refused; narrow the scope or raise the limit.

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| `No credentials for the host backend` | Copy the secrets file, set `OPENAI__KEY`, or use `backend: "docker"` |
| `Required uv version >=0.13.5 does not match` | Upgrade uv (`choco upgrade uv`, `pip install -U uv`, or the standalone installer) or use `backend: "venv"` |
| `PR-Agent exited with code 1` | The message includes the stderr tail; usually credentials, endpoint, or model errors |
| `Could not detect a base branch` | Pass `base`, for example `main` |
| Docker backend cannot find the image | Build it once with `docker compose -f docker/opencode-local/docker-compose.yml build pr-agent-cli` |
