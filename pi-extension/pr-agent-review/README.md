# pr-agent-review (Pi extension)

Pi port of `opencode-plugin/pr-agent-review`. It adds one tool, `pr_agent_review`, plus a `/review`
command that runs PR-Agent's review engine on local git changes and returns the markdown report to the
agent. No PR URL, no hosting token, and no webhook server involved.

## Activation

Install it as a personal Pi package from this checkout:

```bash
pi install ./pi-extension/pr-agent-review
```

That writes the package to `~/.pi/agent/settings.json`; `/review` and `pr_agent_review` are available
after Pi reloads. One-off usage without touching settings:

```bash
pi -e ./pi-extension/pr-agent-review
```

Alternatively copy the directory to `~/.pi/agent/extensions/pr-agent-review/`, which Pi discovers at
startup like any other user extension. The copied directory needs `index.ts`, `options.ts`, `runner.ts`,
and `config.json`; `package.json` exists so the directory can also be installed as a package.

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

`path` selects a repository other than the current location (absolute or relative to the session
directory).

`working` includes untracked files, `staged` covers the index only, and `branch` diffs `base...HEAD`
(default base: `origin/HEAD`, then `main`, then `master`).

The tool result details carry `command`, `mode`, `backend`, `repo`, and `diffBytes` for rendering.

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

Commands are registered when the extension loads, so run `/reload` after changing the extension for
`/review` to pick up the new code.

## Backends

| Value | How it runs | Requirements |
| --- | --- | --- |
| `auto` (default) | `venv` if `<root>/.venv` exists, else `uv` | — |
| `venv` | `<root>/.venv/.../python -m pr_agent.cli` | `uv sync` has run once |
| `uv` | `uv run --project <root> python -m pr_agent.cli` | uv >= 0.13.5 (see `tool.uv.required-version`) |
| `docker` | `docker compose run pr-agent-cli` | the `opencode-cli` image from `docker/opencode-local` |

`auto` picks the synced venv, so runs take seconds. If the venv is missing it falls back to `uv`, which
syncs on first use.

## PR-Agent checkout

The extension lives outside the PR-Agent repository, so the checkout is resolved per call, in order:

1. `prAgentRoot` from `config.json` (relative paths resolve against the session directory).
2. `PR_AGENT_ROOT` from the environment.
3. Walking up from the session directory until a directory contains both `pr_agent/cli.py` and
   `pyproject.toml`.
4. Walking up from the extension directory itself, so a local install inside a checkout finds it from
   any working directory.

If none matches, the session directory is used and the run fails with the child process error. Set
`prAgentRoot` when Pi runs outside a checkout.

## Credentials

Host backends (`venv`, `uv`) read the same TOML file the Docker deployment mounts:

```text
<prAgentRoot>/pr_agent/settings_prod/.secrets.toml
```

Copy it from `docker/opencode-local/secrets/.secrets.toml` if it is missing. It is gitignored and holds:

```toml
[openai]
key = "oc_sk_..."
[litellm]
extra_headers = '{"User-Agent": "pr-agent/1.0", "x-opencode-session": "ses-pr-agent-local"}'
```

You can also set `OPENAI__KEY` in the environment (or through the `env` option) instead. The `docker`
backend ignores this and uses its mounted copy.

PR-Agent runs as its own process and calls the model itself, so Pi's provider login is not visible to it.
The extension removes the hosting credentials (no GitHub/GitLab token, no PR URL, no webhook), but it
still needs a model key for that process. When neither the secrets file nor `OPENAI__KEY` is present, the
tool fails before running git and names the checkout it resolved, where that path came from
(`config.json`, `PR_AGENT_ROOT`, the session directory, the extension directory), and the three ways to
provide a key.

## Options

Options come from `config.json` next to `index.ts` (override the path with `PR_AGENT_CONFIG`).
`PR_AGENT_BACKEND` and `PR_AGENT_ROOT` override the file from the environment.

| Option | Default | Meaning |
| --- | --- | --- |
| `backend` | `auto` | `auto`, `venv`, `uv`, or `docker` |
| `prAgentRoot` | detected from the session, then the extension directory | PR-Agent checkout |
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

List options accept either an array or a comma-separated string. A malformed `config.json` fails the
extension load so the problem is visible instead of silently falling back to defaults.

## How it works

1. Resolves the repository root with `git rev-parse --show-toplevel`.
2. Builds a unified diff (including untracked files in `working` mode).
3. Pipes it to `pr_agent.cli --stdin --output <temp file> <command>`.
4. Reads the report back from the temp file and returns it as tool content.

The temp file matters: PR-Agent's logger writes to stdout, so parsing stdout would mix logs into the
report. `--output` gives clean markdown.

PR-Agent reports model failures by writing a `Failed to review PR` artifact and exiting `0`. The runner
treats that as a failure and returns the artifact, PR-Agent's allowlisted reason (via
`PR_REVIEWER__PUBLISH_ERROR_DETAILS`), and the log tail that carries the provider error. Any failure also
appends an environment report with the config path, resolved checkout and where it came from, backend,
interpreter, credential source, endpoint, and models.

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
| `Failed to review PR` | Now a tool error: read PR-Agent's reason and the log tail, usually a provider auth, quota, or timeout problem |
| `No PR-Agent checkout at …` | The resolved `prAgentRoot` is not a checkout; set `prAgentRoot` or `PR_AGENT_ROOT`, or install the extension inside a checkout |
| `No PR-Agent model credentials for checkout …` | Create the secrets file, set `OPENAI__KEY`, or add it under `env` in `config.json` |
| `Required uv version >=0.13.5 does not match` | Upgrade uv (`choco upgrade uv`, `pip install -U uv`, or the standalone installer) or use `backend: "venv"` |
| `PR-Agent exited with code 1` | The message includes the stderr tail; usually credentials, endpoint, model, or a wrong `prAgentRoot` |
| `Could not detect a base branch` | Pass `base`, for example `main` |
| Docker backend cannot find the image | Build it once with `docker compose -f docker/opencode-local/docker-compose.yml build pr-agent-cli` |
