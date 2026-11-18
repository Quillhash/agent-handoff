# agent-handoff-mcp

Two-way task handoff between **Claude Code** (on your machine) and **Devin** (in the cloud), with Codex ready as a third target.

Devin's own MCP already lets Claude start a Devin session. Nothing in the cloud can reach a Claude running on your laptop, though. This repo adds a small hosted **hub** (an MCP server with Postgres) that both agents connect to, plus a **runner** on your machine that picks up handoffs sent to Claude while the machine is online.

```
Claude Code ──MCP──┐                      ┌──Devin v3 API──> Devin session
                   ├──> handoff hub (Railway + Postgres)
Devin ───────MCP───┘            ▲
                                │ poll / heartbeat (REST)
                    handoff-runner on your laptop ──> claude -p / codex exec
```

- **Claude → Devin**: `handoff_create(to: "devin")` starts a Devin session with the prompt, repo, branch and context. `handoff_reply` forwards follow-ups to that session. `handoff_get` pulls Devin's latest message (the result) and its PR.
- **Devin → Claude**: `handoff_create(to: "claude", devin_session_id)` queues the task. The runner on your laptop claims it, checks out the repo/branch, runs `claude -p` headless and posts the result back. The hub then messages the originating Devin session with the result, which wakes it. You can also pick it up yourself from an interactive Claude with `handoff_list(inbox: true)` → `handoff_claim` → `handoff_complete`.
- **Out of usage / offline**: the runner sends a heartbeat. `to: "auto"` sends work to Claude when a runner is online with usage left, otherwise to Devin. When `claude` reports a usage limit mid-task, the runner hands the task to Devin (with the thread so far) and marks itself limited for `HANDOFF_LIMIT_COOLDOWN_MINUTES`.
- **Follow-ups on a finished local handoff** requeue it, and the runner resumes the same Claude session (`--resume`).

## MCP tools

| Tool | What it does |
| --- | --- |
| `handoff_create` | Hand a task to `devin`, `claude`, `codex` or `auto` (title, prompt, repo, branch, context, devin_session_id). |
| `handoff_list` | List handoffs; `inbox: true` = waiting for you. |
| `handoff_get` | Full handoff + thread (refreshes Devin status/result/PR). |
| `handoff_claim` | Take a queued handoff in this session. |
| `handoff_complete` | Report the result (+ PR URL); the sender is notified. |
| `handoff_reply` | Follow-up in either direction. |
| `handoff_cancel` | Cancel. |
| `agents_status` | Is the laptop runner online / usage-limited? Is Devin configured? |

## Install

The hub runs at `https://agent-handoff-hub-production.up.railway.app` (Railway project *QuillAudits Services*, service `agent-handoff-hub`). Each caller has its own token, kept in that service's `AGENT_TOKENS` variable (`claude=…,devin=…,runner=…`). Tokens never need to be pasted anywhere: the setup script reads them from Railway.

### Your machine: Claude Code + runner (one time)

Needs Node 20.12+, `git`, `claude` signed in, and Railway access to QuillAudits Services: either the [Railway CLI](https://docs.railway.com/guides/cli) signed in, or `RAILWAY_API_TOKEN` set to an account/workspace token.

```bash
git clone https://github.com/Quillhash/agent-handoff && cd agent-handoff
npm install                 # also builds dist/
railway login               # skip if RAILWAY_API_TOKEN is set
npm run setup               # adds the "agent-handoff" MCP to Claude Code (user scope)
                            # and writes ~/.config/agent-handoff/runner.env (mode 600)
npm run runner              # keep running (tmux, launchd, systemd...) so Devin can reach Claude
```

`npm run setup -- --claude-only` or `-- --runner-only` does one half. Rerun it after rotating tokens.

Manual equivalent: `claude mcp add --transport http --scope user agent-handoff https://agent-handoff-hub-production.up.railway.app/mcp --header "Authorization: Bearer <claude token>"`, and for the runner, `HANDOFF_HUB_URL` + `HANDOFF_RUNNER_TOKEN` in the environment or in `~/.config/agent-handoff/runner.env`.

### Devin

Settings → MCP servers → **Add custom server** (or Customize → MCPs):
- Transport: HTTP (streamable)
- URL: `https://agent-handoff-hub-production.up.railway.app/mcp`
- Header: `Authorization: Bearer <devin token>`

If a client cannot send headers, use `https://agent-handoff-hub-production.up.railway.app/mcp/<token>`.

### Runner options

A run is reported as **failed**, not done, when Claude hit tool calls it was not allowed to make, left uncommitted changes, or made commits it did not push; the result says which. Finished worktrees stay on disk; remove them with `git worktree remove <path>` (or `git worktree prune` after deleting the folder).

While the runner is running, `agents_status` reports Claude as available. Environment variables override `runner.env`.

| Runner env | Default | |
| --- | --- | --- |
| `HANDOFF_AGENTS` | `claude` | `claude,codex` to also run Codex handoffs via `codex exec`. |
| `HANDOFF_POLL_SECONDS` | `15` | |
| `HANDOFF_ON_LIMIT` | `devin` | `requeue` keeps the task queued for Claude instead. |
| `HANDOFF_LIMIT_COOLDOWN_MINUTES` | `60` | |
| `HANDOFF_TIMEOUT_MINUTES` | `60` | Per task. |
| `HANDOFF_CLAUDE_ARGS` | `--permission-mode bypassPermissions` | Flags for `claude -p`. Headless runs have nobody to approve tool calls, so by default Claude can run any command (git, gh, tests) inside the task's worktree. For a tighter leash use e.g. `--permission-mode acceptEdits --allowedTools Bash(git:*) Bash(gh:*) Bash(npm:*)`; any denied call fails the handoff. |
| `HANDOFF_CODEX_ARGS` | `--sandbox danger-full-access` | Flags for `codex exec` (network is needed to push). |
| `HANDOFF_REPOS` / `HANDOFF_REPO_MAP` | | JSON map (or path to a JSON file) of `owner/repo` → local path, e.g. `{"Quillhash/usepulse-fe":"/Users/me/code/usepulse-fe"}`. |
| `HANDOFF_WORKSPACE` | `~/agent-handoff-workspace` | Where repos without a mapping are cloned, and where each repo handoff gets its own git worktree (`worktrees/<owner>__<repo>__<id>`) on the handoff's branch or `handoff/<id>`. Your own checkout is never modified. |
| `HANDOFF_ENV_FILE` | `~/.config/agent-handoff/runner.env` | |

## Try it

- **Claude → Devin**: in Claude Code, *"Hand this off to Devin with agent-handoff: …"*. Claude calls `handoff_create(to: "devin")` and gets the Devin session URL; ask it to check `handoff_get` later.
- **Devin → Claude**: tell Devin *"Hand this to my local Claude via agent-handoff: …"*. Devin calls `handoff_create(to: "claude", devin_session_id: <its id>)`; the runner executes it and Devin gets a message with the result.

## Hub configuration

| Env | |
| --- | --- |
| `DATABASE_URL` | Postgres. Tables are created on start. |
| `AGENT_TOKENS` | `claude=<t>,devin=<t>,runner=<t>` (add `codex=<t>` for a Codex client). |
| `DEVIN_API_KEY`, `DEVIN_ORG_ID` | Devin v3 API (service user key). |
| `PUBLIC_URL`, `PORT` | |
| `RUNNER_ONLINE_SECONDS` | Heartbeat age that still counts as online (default 120). |

## Develop

```bash
npm install
npm run build
TEST_DATABASE_URL=postgres://postgres@localhost:5432/handoff_test npm test   # e2e: real hub + Postgres, mock Devin API, fake claude
```

Deploy: `railway up --service agent-handoff-hub` (Dockerfile build).
