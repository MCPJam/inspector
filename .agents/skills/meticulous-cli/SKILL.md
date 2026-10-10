---
name: meticulous-cli
description: Overview of the Meticulous CLI tool and its global options. Use when asking about the meticulous CLI in general, available commands, or global flags that apply to all commands.
user-invocable: true
---

# Meticulous CLI

The `meticulous` CLI records user sessions and replays them to catch visual regressions. It is installed as part of `@alwaysmeticulous/cli`.

> Before starting, run the `meticulous-cli-update` skill to ensure the Meticulous CLI and skills are up to date — unless it has already run earlier in this conversation, in which case skip it.

## Invocation

```bash
meticulous <command> [options]
```

The skills assume `meticulous` is on `PATH`. The `meticulous-cli-update` skill installs it globally via `npm install --global @alwaysmeticulous/cli@latest` if missing. It can also be invoked as `npx @alwaysmeticulous/cli` when installed locally per-project.

## Command Groups

| Command               | Purpose                                                                                          |
| --------------------- | ------------------------------------------------------------------------------------------------ |
| `agent`               | Read, analyse, and trigger test runs — the agent-facing commands, also exposed on the MCP server |
| `auth`                | Authenticate with Meticulous (login, whoami, logout, project selection)                          |
| `debug`               | Set up AI-ready debug workspaces for investigating replay diffs and replays                      |
| `download`            | Download sessions, replays, and test runs locally                                                |
| `local`               | Find sessions relevant to the current branch's code changes                                      |
| `project`             | Inspect the project you're authenticated against                                                 |
| `simulate` / `replay` | Replay a recorded session against a URL                                                          |
| `schema`              | Output the CLI command schema as JSON (for agent/programmatic use)                               |

See the reference for each group for full option details:

- [references/agent.md](references/agent.md)
- [references/auth.md](references/auth.md)
- [references/debug.md](references/debug.md)
- [references/download.md](references/download.md)
- [references/local.md](references/local.md)
- [references/project.md](references/project.md)
- [references/simulate.md](references/simulate.md)
- [references/schema.md](references/schema.md)

## Global Options

These options are accepted by every command:

| Option       | Type   | Default         | Description                                                                  |
| ------------ | ------ | --------------- | ---------------------------------------------------------------------------- |
| `--logLevel` | string | `info`          | Log verbosity: `trace`, `debug`, `info`, `warn`, `error`, `silent`           |
| `--dataDir`  | string | `~/.meticulous` | Directory where sessions, replays, and other data are stored                 |
| `--jsonArgs` | string | —               | Pass all options as a JSON string (useful for programmatic/agent invocation) |

`--rawJson` is a deprecated alias for `--jsonArgs`. `--dryRun` is **not** global — it is available only on the commands that perform actions (e.g. the `ci` / `agent` run-triggering and upload commands, and `simulate`); check the command's reference or `meticulous schema <command>`.

## Authentication

Commands authenticate via OAuth. The login token is stored on disk and reused across sessions — in an interactive terminal, a command that needs auth opens a browser sign-in automatically; without a TTY (the usual agent case) it fails and tells you to run `meticulous auth login`. Run `meticulous auth whoami` to see the current state. Project-scoped commands also need a default project, set at login or with `meticulous auth set-project`. See [references/auth.md](references/auth.md).

An API token (via `--apiToken` or the `METICULOUS_API_TOKEN` environment variable, scoped to a specific organization/project) is also supported, and is the way to authenticate in non-interactive contexts such as CI. Some agent platforms instead inject a bearer credential into outbound requests to `app.meticulous.ai`; that works too, and `auth whoami` reports it as `credentials injected at request time`.

## MCP server

The `agent` commands are also exposed as tools on a hosted **MCP server** at `https://app.meticulous.ai/api/mcp`, so an MCP-enabled client (Claude Code, Cursor, Codex) can call them directly rather than shelling out to the CLI. Most read/analysis commands map to a `get_<command>` tool that returns the same data as the CLI command's `--json` output — for example `agent test-run-diffs` ⇄ `get_test_run_diffs`, `agent dom-diff` ⇄ `get_dom_diff`, and `download session` ⇄ `get_session_data`. The two mutating commands (`upload-build`, `trigger-test-run`) also have MCP tools, but not 1:1 — see [references/agent.md](references/agent.md) for the full mapping, including that important difference. Connect with just the endpoint URL (browser OAuth on first use). The skills are written in terms of the CLI; substitute the matching tool where noted if you have the MCP server connected — but note MCP tools never infer git context (`commitSha`/`baseSha`/diff), unlike the CLI, so always pass those explicitly when using MCP.

## Example

```bash
# Print schema for all commands (agent use)
meticulous schema

# Run a single replay locally
meticulous simulate --sessionId=<id> --appUrl=http://localhost:3000
```
