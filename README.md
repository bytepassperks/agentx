# agentx

Devin-style autonomous coding agent that runs on your own Windows machine as a single `agentx.exe`.
Talks to any Anthropic-compatible `/v1/messages` endpoint (your own proxy, Bedrock gateway, or Anthropic directly).

## Install (Windows, one command)

```powershell
$env:AGENTX_TOKEN="YOUR_TOKEN"; $env:AGENTX_GITHUB_TOKEN="ghp_xxx"; irm https://raw.githubusercontent.com/bytepassperks/agentx/main/install.ps1 | iex
```

`AGENTX_GITHUB_TOKEN` is optional (needed for `git_push` / PR creation). If `~/.claude/settings.json` already has your token/base URL, the installer picks it up automatically. Base URL defaults to `https://claudemax-v4.pages.dev`; override with `$env:AGENTX_BASE_URL`.

Then open a new terminal in any project:

```
agentx                      # interactive
agentx "add tests for utils.py and make them pass"
agentx -c                   # continue last session in this folder
agentx update               # upgrade
```

## What it does

- Streams responses; runs an autonomous plan → edit → run → verify loop until the task is done.
- Tools: PowerShell/bash `shell`, `read_file`/`write_file`/`edit_file`, `list_dir`/`glob`/`grep`, `github` (PRs, issues, repos), `git_push` (token auth, no credential setup), `web_fetch`, `todo_write`, `memory_save`, `ask_user`.
- Memory: per-project and global notes in `~/.agentx/`, reads `AGENTX.md` / `AGENTS.md` / `CLAUDE.md` from the repo, session history with `/resume`.
- Context management: auto-compacts when the window fills; `/compact` on demand.

## Session commands

`/help` `/compact` `/clear` `/resume [n]` `/tasks` `/model <name>` `/config` `/memory` `/cwd <dir>` `/usage` `/exit`, and `!cmd` to run a shell command directly. `Ctrl+C` interrupts the current turn.

## Config

`~/.agentx/config.json` or `agentx config --token T --base-url U --model M --github-token G`.

## Build from source

```
bun install
bun run build:win   # dist/agentx.exe
```

Releases are built by GitHub Actions on `v*` tags.
