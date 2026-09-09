# Drive a cloud browser from a coding agent

The `browser` CLI commands accept `--cloud`. Each `open` creates a separate,
blank browser profile in a metered desktop. No project computer attachment or
host configuration is required. The caller must be a project member, and the
cloud deployment needs its desktop template, rate and browser JWT keys configured.

Use your existing `mcpjam cloud login` or `MCPJAM_API_KEY`. Select staging with
`MCPJAM_API_URL=https://staging.mcpjam.com/api/v1`; credentials must belong to that
deployment. Local consent is never sent to the cloud.

```sh
export MCPJAM_API_URL=https://staging.mcpjam.com/api/v1
mcpjam browser open --cloud --project PROJECT_ID --run-key my-task --mode allow_all
mcpjam browser navigate https://example.com --cloud --project PROJECT_ID --command-id first-navigation
mcpjam browser observe --cloud --project PROJECT_ID --mode a11y
mcpjam browser act --cloud --project PROJECT_ID --verb click --ref e3 --command-id click-one
mcpjam browser observe --cloud --project PROJECT_ID --mode screenshot
mcpjam browser trace --cloud --project PROJECT_ID
mcpjam browser sessions --cloud --project PROJECT_ID
mcpjam browser close --cloud --project PROJECT_ID
```

The CLI remembers the last session separately for each deployment and project.
Pass `--session SESSION_ID` on commands to select another. `open --run-key KEY`
reattaches the same agent session with the same policy; omit the key for a fresh
session. A closed key cannot be reopened: use a new key. `close` in cloud mode
ends the session and releases its desktop (unlike local participant-only close).

A policy is stored when the session opens. `--mode read_only` permits observation
only. `--mode allowlist --origin https://example.com` restricts navigation and
returned observations. The same daemon handoff protections apply: taking human
control blocks agent commands until control is handed back.

A browser sleeps through the existing Playground idle lifecycle and wakes when
its agent next issues a command. Profile state lasts within that session, subject
to the existing retention policy. Cloud sessions currently start blank; saved
profile selection and joining a Playground-owned browser are not exposed here.
Cloud `--profile ephemeral`, `--attach require`, initial `--observe`, and capture
configuration flags are rejected rather than silently changing their meaning.

## Retry and history contract

Use a stable `--command-id` for mutating commands. Admission is persisted before
execution. A completed retry returns the saved result; an in-flight or interrupted
claim returns `unknown` and is never executed again. Check `trace` before deciding
what to do next. Never retry an unknown action under a new ID without checking the
page: the original action may have happened. Reusing an ID with different input
is rejected. A history write failure is reported on the result.

Screenshots are downloaded to files by default. The cloud stores at most 512,000
base64 characters per screenshot and 64,000 JSON characters per result; oversized
pictures report an omission. History is bounded to 10,000 commands per session.
Trace lists at most 100 entries; continue with `--after-seq`. Screenshots are
fetched separately and are not embedded in trace listings.

## API and rollout

`POST /api/v1/browser-sessions/{session,sessions,command,trace,note,artifact,close}`
uses the existing public bearer authentication. Requests include `projectId`, and
all operations other than open/list include `sessionId`. Command bodies use the
existing browser agent contract (`navigate`, `act`, `observe`); outcomes are
`executed`, `refused`, or `unknown`, returned in-band with HTTP 200. Protocol and
authorization failures use the standard v1 error envelope.

Deploy the backend changes first (`browserAgentSessions`, `browserAgentCommands`
and `/agent-browser/*`), then Inspector. Publish the SDK containing
`PlatformApiClient.browserSession` before publishing the CLI that consumes it.
A mismatched backend refuses before any desktop is provisioned.

Verification covers the real CLI against a loopback cloud endpoint, the Inspector
route against mocked control-plane/daemon transports, and Convex mutations with
its test database. Live E2B provisioning must still be smoke-tested on staging:
open two keys, navigate them independently, sleep/wake one, and close both while
checking their desktop usage records.
