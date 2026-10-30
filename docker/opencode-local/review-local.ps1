<#
.SYNOPSIS
    Run PR-Agent on a local Git checkout with the same image and OpenCode Go
    configuration as the webhook server.

.DESCRIPTION
    Branch mode (default) compares committed HEAD against the merge base with
    -Target and writes review.md / description.md / improve.md into the repo root.
    The working tree must be clean.

    -Uncommitted reviews `git diff HEAD` instead and prints the result to stdout.
    New files must be marked with `git add -N <path>` so they appear in the diff.

.EXAMPLE
    .\review-local.ps1 -Target main

.EXAMPLE
    .\review-local.ps1 -Target main -Command improve

.EXAMPLE
    .\review-local.ps1 -Uncommitted -Command review
#>
[CmdletBinding()]
param(
    [ValidateSet("review", "describe", "improve", "ask")]
    [string]$Command = "review",

    [string]$Target = "main",

    [string]$Repo = (Get-Location).Path,

    [string]$Question,

    [switch]$Uncommitted
)

$root = (& git -C $Repo rev-parse --show-toplevel 2>$null)
if ($LASTEXITCODE -ne 0 -or -not $root) {
    throw "'$Repo' is not inside a Git repository."
}
$root = $root.Trim()

$dockerArgs = @(
    "compose",
    "-f", (Join-Path $PSScriptRoot "docker-compose.yml"),
    "--profile", "cli",
    "run", "--rm", "--no-deps",
    "-v", "${root}:/repo",
    "-w", "/repo",
    "--entrypoint", "python"
)

$cliArgs = @("pr-agent-cli", "/app/pr_agent/cli.py")
$commandArgs = @()

if ($Command -eq "ask") {
    if (-not $Question) {
        throw "-Question is required when -Command is ask."
    }
    $commandArgs = @($Question)
}

if ($Uncommitted) {
    $diff = & git -C $root diff --no-color HEAD -- .
    if (-not $diff) {
        throw "No tracked changes in $root. Use 'git add -N <path>' to include new files."
    }
    $diff | & docker @dockerArgs -T @cliArgs --stdin $Command @commandArgs
}
else {
    & docker @dockerArgs -e "CONFIG__GIT_PROVIDER=local" @cliArgs --pr_url $Target $Command @commandArgs
}

exit $LASTEXITCODE
