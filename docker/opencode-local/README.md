# PR-Agent on Docker with OpenCode Go

Runs PR-Agent against the OpenCode Go gateway using two models only:
`deepseek-v4.1-flash` as the primary, `glm-5.3-flash` as the quick researcher.

| Setting | Value | Used by |
| --- | --- | --- |
| `config.model` | `openai/deepseek-v4.1-flash` | `/review`, `/improve`, `/add_docs`, `/generate_labels` |
| `config.model_weak` | `openai/glm-5.3-flash` | `/describe`, `/ask`, `/ask_line`, `/update_changelog` |
| `config.fallback_models` | `["openai/glm-5.3-flash"]` | retry target when the primary fails |

Both run with `reasoning_effort = high`. `additional_reasoning_effort_models` lists them because LiteLLM does
not know these IDs; without it PR-Agent would not send the parameter at all. Both models support
`low | high | max` — `medium` (PR-Agent's default) is rejected, which is why `high` is explicit.

## 1. Add a Console API key

Open <https://opencode.ai/console> → **Account** → **Personal API keys** → **Add API key**, choose the
workspace subscribed to Go, and copy the `oc_sk_...` value.

Paste it into `secrets/.secrets.toml`:

```toml
[openai]
key = "oc_sk_..."
```

The gateway only accepts Console API keys. The `sk-P...` key OpenCode keeps in
`~/.local/share/opencode/auth.json` is rejected with `401 Invalid credential`; tested against both
`/inference/openai/v1` and `/inference/go/openai/v1`.

No other edits are needed — the model routing lives in `docker-compose.yml`.

## 2. Run it

Build once (the `cli` and `github_app` targets share the dependency layer):

```powershell
docker compose build
```

Webhook server:

```powershell
docker compose up -d pr-agent
docker compose logs -f pr-agent
curl.exe http://localhost:3000/   # {"status":"ok"}
```

One-shot CLI run:

```powershell
docker compose --profile cli run --rm `
  -e GITHUB__USER_TOKEN=<github_pat> `
  pr-agent-cli --pr_url https://github.com/org/repo/pull/123 review
```

```powershell
docker compose --profile cli run --rm `
  -e GITHUB__USER_TOKEN=<github_pat> `
  pr-agent-cli --pr_url https://github.com/org/repo/pull/123 ask "What changed and why?"
```

CLI runs use `config.model_weak`, so `/ask` and `/describe` go to GLM-5.3-Flash while `/review` and
`/improve` go to DeepSeek V4.1 Flash.

## 3. Reviewing local code

The webhook server only reacts to GitHub events; it cannot read your disk. Local reviews run through the
same CLI image, with your checkout bind-mounted at `/repo`. `review-local.ps1` wraps that:

```powershell
# committed changes on the current branch vs main -> review.md
.\review-local.ps1 -Target main

# describe / improve -> description.md / improve.md
.\review-local.ps1 -Target main -Command improve

# uncommitted tracked changes -> stdout
.\review-local.ps1 -Uncommitted

# research question about the branch diff -> review.md (uses glm-5.3-flash)
.\review-local.ps1 -Target main -Command ask -Question "Is anything in this diff unsafe?"
```

Branch mode compares `HEAD` to the merge base with `-Target` and requires a clean working tree, so
commit or stash first. It writes `review.md` / `description.md` / `improve.md` into the repo root;
untracked output files do not block the next run. `ask` also writes `review.md`, so run it before or
after a review, not instead of keeping one.

`-Uncommitted` uses plain-diff mode (`git diff HEAD`, staged and unstaged). New files stay invisible
until `git add -N <path>`. Plain-diff mode also skips repository context files such as `AGENTS.md`,
because that provider cannot fetch repo files; branch mode includes them.

Equivalent raw command for bash or Git Bash:

```bash
docker compose -f docker/opencode-local/docker-compose.yml --profile cli run --rm --no-deps \
  -v "$PWD:/repo" -w /repo --entrypoint python \
  -e CONFIG__GIT_PROVIDER=local \
  pr-agent-cli /app/pr_agent/cli.py --pr_url main review
```

The `pr-agent-cli` service sets `core.autocrlf=input` and `core.fileMode=false` inside the container.
Without them, Linux Git sees every file in a Windows checkout as modified and branch mode refuses to
run. Output locations can be changed in the reviewed repo's `.pr_agent.toml`:

```toml
[local]
review_path = "artifacts/review.md"
description_path = "artifacts/description.md"
improve_path = "artifacts/improve.md"
```

## 4. GitHub App wiring

Only needed for the `pr-agent` webhook service. Create the App with pull requests/issues **Read & write**,
metadata **Read-only**, and the `issue_comment`, `pull_request`, `pull_request_review`, and
`pull_request_review_comment` events.

Fill in `secrets/.secrets.toml`:

```toml
[github]
app_id = "123456"
webhook_secret = "change-me"
private_key = """-----BEGIN RSA PRIVATE KEY-----
...paste the .pem contents here...
-----END RSA PRIVATE KEY-----
"""
```

Expose port 3000 with `cloudflared tunnel --url http://localhost:3000` (or smee.io), then set the App's
webhook URL to `https://<public-url>/api/v1/github_webhooks` and the same secret. Settings are read at
startup, so after editing the secrets file run `docker compose up -d --force-recreate pr-agent`.

If the container cannot read the mounted file on Linux, make it world-readable:
`chmod -R a+rX secrets` (the image runs as UID 10001).

## 5. Verify the gateway without building

```powershell
curl.exe -X POST "https://opencode.ai/inference/go/openai/v1/chat/completions" `
  -H "Authorization: Bearer oc_sk_..." `
  -H "x-opencode-session: ses-pr-agent-local" `
  -H "Content-Type: application/json" `
  -d '{\"model\":\"deepseek-v4.1-flash\",\"reasoning_effort\":\"high\",\"messages\":[{\"role\":\"user\",\"content\":\"Say hi\"}]}'
```

## 6. Overrides

Every value in the compose `environment` block is `PR_AGENT_*`-templated, so a local `.env` (or the shell)
can change it without editing the file:

```ini
PR_AGENT_REASONING_EFFORT=low
PR_AGENT_MAX_MODEL_TOKENS=120000
```

`custom_model_max_tokens` and `max_model_tokens` are both required: neither model is in PR-Agent's
`MAX_TOKENS` table, and `max_model_tokens` would otherwise clamp every prompt to 32000 tokens.

## 7. Troubleshooting

| Symptom | Cause |
| --- | --- |
| `401 Invalid credential` | Not a Console key (`oc_sk_...`), wrong workspace, or revoked/expired |
| `400 MissingSessionID` | `x-opencode-session` header missing; keep the `[litellm] extra_headers` entry |
| `403` on a model | Free-tier model — only paid or Go models work outside OpenCode |
| `Model ... is not defined in MAX_TOKENS` | `config.custom_model_max_tokens` not set or not positive |
| `The repository is not in a clean state` | Commit or stash tracked changes; branch mode compares committed `HEAD` |
| `No tracked changes` from `-Uncommitted` | Stage new files with `git add -N <path>` so `git diff HEAD` sees them |
| `review-local.ps1 cannot be loaded` | PowerShell execution policy: run `powershell -ExecutionPolicy Bypass -File .\review-local.ps1 -Target main` |
| `Unsupported value: medium` for `reasoning_effort` | Set `PR_AGENT_REASONING_EFFORT=low` or `high` |
| Model change has no effect | Restart the container; settings are read at startup |
