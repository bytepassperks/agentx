# agentx

Devin-style autonomous coding agent that runs on your own Windows machine as a single `agentx.exe`.
Works with NVIDIA's free API (default), OpenRouter, Groq, any OpenAI-compatible `/v1/chat/completions` endpoint, or any Anthropic-compatible `/v1/messages` endpoint. Pick the provider and model in Settings.

## Install (Windows, one command)

1. Get a free key at <https://build.nvidia.com/settings/api-keys> (NVIDIA developer account).
2. In PowerShell:

```powershell
$env:AGENTX_TOKEN="nvapi-…"; $env:AGENTX_GITHUB_TOKEN="ghp_xxx"; irm https://raw.githubusercontent.com/bytepassperks/agentx/main/install.ps1 | iex
```

`AGENTX_GITHUB_TOKEN` is optional (needed for `git_push` / PR creation). Other overrides: `AGENTX_BASE_URL`, `AGENTX_PROVIDER` (`openai`|`anthropic`), `AGENTX_MODEL`. Re-running the installer keeps your existing config.

## Providers & models

| Preset | Endpoint | Notes |
|---|---|---|
| NVIDIA (default) | `https://integrate.api.nvidia.com` | free, ~40 req/min; default model `openai/gpt-oss-120b` (fast, tool-calls). Also `nvidia/nemotron-3-super-120b-a12b`, `deepseek-ai/deepseek-v4-pro-0813`, `moonshotai/kimi-k3` (very slow on the free tier) |
| OpenRouter | `https://openrouter.ai/api` | any model on OpenRouter |
| Groq | `https://api.groq.com/openai` | free tier |
| Anthropic | `https://api.anthropic.com` | or any Anthropic-compatible proxy |

Settings → **Refresh** lists every model the provider serves (`agentx config --models` in the terminal). Context window and rate limits are set by the provider/model; agentx auto-compacts the conversation before the window fills and automatically waits and retries on 429s.

The installer adds an **agentx** shortcut to the Start Menu and Desktop and opens the app.

## Desktop app (default)

`agentx` (or the shortcut) opens a window: pick a project folder, chat, watch streamed replies and every tool call (command, file edit, search…) as expandable cards, see the task list and past sessions, stop a run, compact context, and edit settings — all local (the exe serves the UI on `127.0.0.1` and opens it in an Edge/Chrome app window).

## Terminal mode

```
agentx --cli                # interactive terminal session
agentx "add tests for utils.py and make them pass"
agentx -c                   # continue last session in this folder
agentx --serve --port 4747  # GUI server only (open the URL yourself)
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

`~/.agentx/config.json` or `agentx config --preset nvidia --token T --model M --github-token G` (`--base-url U --provider openai|anthropic` for custom endpoints). Keys are stored only in that file; never commit it.

## Build from source

```
bun install
bun run build:win   # dist/agentx.exe
```

Releases are built by GitHub Actions on `v*` tags.
