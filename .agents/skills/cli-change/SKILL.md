---
name: cli-change
description: Build the mcpjam CLI (@mcpjam/cli) from this working tree, run a changed command against a local MCP fixture with no network or credentials, and keep the command, exit code, stdout and stderr as evidence. Use after changing anything under cli/, before calling the change done.
---

# CLI change

Unit tests call `main()` in-process. This skill runs the built CLI as a user
does and keeps what it printed. Run every command from the repo root.

## 1. Build

```bash
npm run build -w @mcpjam/sdk   # only when sdk/ changed or sdk/dist is missing
npm run build -w @mcpjam/cli
```

The CLI bundle imports `@mcpjam/sdk` and its other dependencies from
`node_modules` at run time. tsup's "imported from external module but never
used" warnings are harmless; on Windows PowerShell 5.1 they print as a red
`NativeCommandError`. The build worked if it ends with `Build success`.

A git worktree has no `node_modules`. Link both the root one and the CLI's own
(`commander` is not hoisted, so the CLI fails with `Cannot find package
'commander'` without it):

```powershell
New-Item -ItemType Junction -Path node_modules -Target <main checkout>\node_modules
New-Item -ItemType Junction -Path cli\node_modules -Target <main checkout>\cli\node_modules
```

```bash
ln -s <main checkout>/node_modules node_modules
ln -s <main checkout>/cli/node_modules cli/node_modules
```

Through those links `@mcpjam/sdk` is the main checkout's `sdk/dist`, so SDK
changes made in the worktree are not in the run. Never delete a link
recursively: that deletes the main checkout's files.

## 2. Doctor

```bash
node .agents/skills/cli-change/verify.mjs doctor
```

Read-only. It checks that `cli/dist/index.js` exists and is newer than every
file in `cli/src`, prints the CLI version and the directory `@mcpjam/sdk`
resolves to, and exits 1 with a `PROBLEM:` line for each failure. Run it
before the first drive and after any surprising result.

## 3. Drive

```bash
node .agents/skills/cli-change/verify.mjs run <label> [--kill-after <seconds>] -- <mcpjam args...>
```

The driver runs `node cli/dist/index.js <args>` without a shell, with
`MCPJAM_TELEMETRY_DISABLED=1` and stdin closed, kills it after 60 seconds by
default, and exits with the CLI's exit code. It writes `command.txt`,
`stdout.txt`, `stderr.txt` and `exit-code.txt` to
`<os tmpdir>/mcpjam-cli-verify/<label>/` and prints the path. A reused label
overwrites the earlier evidence.

Targets that need no network or credentials:

| Fixture                                           | Serves                                                                  | Pass                                                                   |
| ------------------------------------------------- | ----------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| `cli/tests/fixtures/notifying-target-server.mjs`  | stdio: tool `echo` (`text`), resource `demo://greeting`, prompt `greet` | `--command node --args cli/tests/fixtures/notifying-target-server.mjs` |
| `cli/tests/fixtures/policy-target-server.mjs`     | stdio: annotated tools `read_note`, `delete_note`, `echo`               | `--command node --args cli/tests/fixtures/policy-target-server.mjs`    |
| `cli/tests/fixtures/skills-target-server.mjs`     | stdio: Agent Skills, for `mcpjam skills`                                | `--command node --args cli/tests/fixtures/skills-target-server.mjs`    |
| `cli/tests/fixtures/sign-in-target-server.mjs`    | stdio: a tool that answers with a sign-in challenge                     | `--command node --args cli/tests/fixtures/sign-in-target-server.mjs`   |
| `examples/conformance/basic/mock-http-server.mjs` | HTTP: tools, prompts, resources and one `ui://` widget                  | `--url {http}`                                                         |

`{http}` makes the driver start the HTTP fixture on a free loopback port,
substitute its URL and stop it afterwards. It fails the protocol conformance
localhost Host-header check by design.

Inline JSON works from bash. Windows PowerShell 5.1 strips the double quotes
from inline JSON passed to a native program, so there pass a file
(`--tool-args @<path>`) written outside the repo. The CLI accepts the
byte-order mark that `Set-Content -Encoding utf8` writes.

```bash
node .agents/skills/cli-change/verify.mjs run tools-call -- tools call --command node --args cli/tests/fixtures/notifying-target-server.mjs --tool-name echo --tool-args '{"text":"hello"}' --format json
node .agents/skills/cli-change/verify.mjs run doctor-http -- server doctor --url {http} --format json
```

```powershell
$argsFile = Join-Path $env:TEMP "mcpjam-cli-verify\echo-args.json"
New-Item -ItemType Directory -Force (Split-Path $argsFile) | Out-Null
Set-Content -Path $argsFile -Value '{"text":"hello"}' -Encoding utf8
node .agents/skills/cli-change/verify.mjs run tools-call -- tools call --command node --args cli/tests/fixtures/notifying-target-server.mjs --tool-name echo --tool-args "@$argsFile" --format json
node .agents/skills/cli-change/verify.mjs run doctor-http -- server doctor --url "{http}" --format json
```

## 4. Evidence

The output contract, from `cli/src/lib/output.ts` and `cli/src/index.ts`:

- stdout holds only the result document. Errors go to stderr as
  `{"error":{"code":"...","message":"...","details":...}}`. While a command
  runs, `console.log`, `info` and `debug` are routed to stderr.
- `--format json` prints compact JSON. Without `--format`, the CLI prints
  `human` to a terminal and `json` to a pipe, so the driver gets JSON. Pass
  `--format` anyway so the evidence names it.
- Exit codes: `0` success; `1` an operational error or a check that ran and
  failed (`AUTH_REQUIRED`, `TIMEOUT`, `SERVER_UNREACHABLE` included); `2` a
  usage error (`USAGE_ERROR`, written to stderr with empty stdout); `3` an
  incomplete conformance or eval gate, or a saved login for another
  deployment. Some commands add their own codes and say so in their
  description in `commands.md` (`tasks watch`: 6, 7, 130).

Report, for each command you changed: the exact command from `command.txt`,
the exit code, the stdout fields that show the change, the stderr content
(usually empty), and the evidence path. Also run one failing case (a missing
required flag exits 2 with a `USAGE_ERROR` on stderr) when the change touches
argument handling.

## 5. Command map

`commands.md` lists every command and subcommand from the CLI's `--help`.
After adding, renaming or re-describing a command, regenerate it:

```bash
npm run map:commands -w @mcpjam/cli
```

`cli/tests/command-map.test.ts` fails while the map is stale.

## 6. What cannot be verified offline

Do not log in, use an API key, or call MCPJam to verify a change.

- Commands marked `[contacts MCPJam]` in `commands.md` (`cloud`, `registry`,
  `browser`, hosted `readiness`, `test`, `apps render` and `apps session`)
  need an account or MCPJam-hosted inference. Run their `--help` and their
  usage-error path, rely on the tests that serve a fake MCPJam API on
  loopback (`cli/tests/support/fake-mcpjam.ts`), and list in the PR which
  commands were not run against MCPJam. The help of `cloud status` and of
  `cloud eval validate` (without `--project`) says they make no network
  call; `cloud status` still reads your saved login.
- `compat` fetches the live host catalog from MCPJam unless you pass
  `--offline`.
- `oauth login`, `oauth conformance` and `xaa run` need an authorization
  server, and none of the fixtures above is one.
- `inspector open` and `inspector start` run `npx -y @mcpjam/inspector@latest`
  unless they find a local start script, so they test the published
  Inspector. Use the `run-inspector` skill for Inspector changes.
- `mcp` is a long-lived stdio server that the driver cannot hold a session
  with. `cli/tests/mcp.test.ts` drives the same server in-process.
- `telemetry enable` and `telemetry disable` write your real telemetry state.
  Use `telemetry status` only.

## 7. Cleanup

The driver stops the HTTP fixture, and the CLI stops a stdio fixture when it
exits. After a killed run, list leftover fixture processes and stop each one
by its process ID:

```powershell
Get-WmiObject Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -match 'mock-http-server|target-server' } | Select-Object ProcessId, CommandLine
```

```bash
pgrep -af 'mock-http-server|target-server'   # Linux and macOS; Git Bash has no pgrep
```

Evidence stays in `<os tmpdir>/mcpjam-cli-verify/` until you delete it.
