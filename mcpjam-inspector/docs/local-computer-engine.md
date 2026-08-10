# Local computer engine ("This machine")

Engineering notes for the Playground's local computer engine: what it is, what
it is *not*, and the checklist for turning it on and off in production. The
user-facing page lives in the separate Mintlify repo behind
`docs.mcpjam.com/inspector/*` — see the launch checklist below.

## What it is

A second **engine** behind the Computer surface. Where the cloud engine runs
`bash` in an E2B sandbox reached through the Convex control plane, the local
engine runs it as a child process of the inspector server itself, in a
per-project workspace directory under `~/.mcpjam/computer/<projectId>`.

There is no Convex row for the local machine, so there is no reserve/wake, no
sandbox-info exchange, no `recordComputerCommand`, no billing, and no idle
sweep. The machine is always ready.

### Pieces

| Concern | Where |
| --- | --- |
| Engine resolution + actor coercion | `server/utils/computers/engine.ts` |
| Bash execution, env allowlist, workspace dirs, journal | `server/utils/computers/local-machine.ts` |
| Consent capability (mint / verify / revoke) | `server/utils/computers/local-consent.ts`, `server/routes/mcp/computers.ts` |
| Guest boundary | `server/utils/computers/local-engine-request.ts` (`isGuestChatRequest`) |
| node-pty loader + availability probe | `server/utils/computers/local-pty.ts` |
| PTY adapter onto the shared `createPtyWithCwd` | `server/utils/computers/local-pty-adapter.ts` |
| Terminal handshake nonces | `server/utils/computers/local-terminal-auth.ts` |
| Terminal WebSocket | `server/routes/web/local-computer-terminal.ts` |
| Client engine resolution | `client/src/hooks/useComputerEngine.ts` |
| Consent projection (storage only) | `client/src/hooks/useLocalComputerConsent.ts` |
| Computer tab faces | `client/src/components/computer/*` |

## Trust model

Read this before changing anything in `local-machine.ts` or the terminal route.
It mirrors the `TRUST MODEL` block at the top of `local-machine.ts`.

- **This is not a sandbox.** Commands run as the OS user, with all of that
  user's permissions. The boundaries are *consent*, *per-command chat approval*,
  and the *actor gates* — never paths.
- **The workspace dir is a convention**, a tidy default cwd, not confinement.
  What *is* validated is the project key, because it becomes a path segment
  under a fixed root: it must be exactly one bounded segment.
- **The child env is an allowlist**, not a secret-name denylist. It reduces
  accidental leakage of cloud credentials into transcripts and PTYs; it is not
  a security boundary, since a same-user process can read credential stores
  regardless.
- **Consent is server-verified.** A request field alone is never proof. Grant
  mints a random capability; the server persists only its SHA-256 hash
  (`~/.mcpjam/computer/consent.json`, 0600); the client stores the plaintext
  and presents it in `X-MCPJam-Local-Consent`, which the server re-verifies on
  every use. The client deliberately does **not** pre-verify — a stale token
  simply fails the next server check.
- **Consent is device-scoped**, not per-project: the thing being consented to
  is *this machine* executing commands.

The consent gate's copy is the honest statement of all of the above, and should
stay blunt:

> The bash tool runs real commands on this computer, as your user account. The
> project folder is only a starting directory, not a sandbox — commands can read
> or change any files and credentials your user can access. Each agent command
> still asks for approval in chat before it runs.

## Actor and route enumeration

Every entry point into local execution, with what gates it:

| Entry point | Gates |
| --- | --- |
| Chat `bash` (playground) | non-hosted + kill switch + signed-in non-guest + server-verified consent + per-command approval |
| Chat `bash` (guest / chatbox / web route) | **never local** — `isGuestChatRequest` forces cloud |
| Comparison cards / org-model turns | same engine resolution as the playground; no separate path |
| Terminal nonce mint (`POST /api/mcp/computers/local-terminal-token`) | inspector session + verified sign-in + non-guest + kill switch + server-verified consent + availability probe + validated project key |
| Terminal WebSocket (`GET /api/web/computers/local-terminal`) | allowed `Origin` (**absent Origin rejected**) + availability probe + single-use, 60s, project-bound nonce + the nonce's consent fingerprint must still match the live capability |
| Hosted build | `/api/mcp` unmounted, kill switch forced off, WS route not mounted, `terminalAvailable: false` |

The terminal has **no per-command approval** — an interactive shell can't have
one. That is precisely why its mint requires consent that already exists, and
why the nonce is single-use with a short TTL.

The nonce also carries a **fingerprint of the consent capability** it was minted
against (the capability's stored hash), which the WebSocket re-checks against the
live one. Without that, the 60s TTL would outlive a revoke: a nonce minted a
second before the user clicked "Forget & re-authorize" would still open a shell.
A re-grant from another browser profile rotates the capability and invalidates
outstanding nonces the same way.

## Kill switch

```dotenv
MCPJAM_LOCAL_COMPUTER_ENABLED=false
```

Turns the whole engine off on a server:

- `GET /api/web/computers/config` reports `engines.local.available: false` with
  a reason, `terminalAvailable: false`, and `defaultEngine` falls through to
  cloud (or `null` when no engine can serve).
- The consent routes and the terminal mint 404.
- The engine resolver never resolves `local`, so chat bash goes to the cloud
  engine (or reports that no computer is available).

It is forced off in hosted mode regardless of the env var.

**Caveat that governs rollback:** the kill switch is a *server* env var. Users
running a published `npx @mcpjam/inspector` or a packaged Electron build are on
their own machines — flipping anything server-side does not reach them. Pulling
the feature back from already-published clients needs a **patch release**. Plan
rollback accordingly: the feature flag governs UI exposure in the hosted app;
the kill switch governs a given self-hosted server; neither retroactively
disarms a shipped binary.

## Cloud-only surfaces

Swarms, evals, and user testing execute their computer commands in MCPJam cloud
sandboxes **regardless** of the engine setting, and preflight on
`capabilities.ephemeralCloudAvailable`. They carry the `CloudRunBadge` so the
provenance is visible. Do not wire the local engine into them without a
separate design pass — they run unattended, and the per-command approval that
makes local bash safe in chat does not exist there.

## Terminal degrade

`node-pty` is an **optional** dependency with a native addon. Three shipping
paths legitimately lack it, and none may crash:

1. `npx @mcpjam/inspector` on a machine with no build toolchain — npm skips the
   optional dependency and the install still succeeds.
2. The **packaged Electron app**, which carries no `node_modules` at all
   (`@electron-forge/plugin-vite` packages only `.vite`), so the runtime require
   always fails. **Electron is terminal-degrade by design in v1.** Real support
   needs `extraResource` plus custom resolution and is a scoped follow-up.
3. An ABI mismatch after a Node upgrade.

In all three the loader returns `{ ok: false }`, the probe reports
`terminalAvailable: false`, and the Computer tab shows a note explaining that
the terminal isn't available while chat bash keeps working. `node-pty` is listed
in `external` for both `server/tsup.config.ts` and `vite.main.config.ts` — it
can never be bundled, and the Electron main build fails outright without the
latter entry.

## Analytics

All events are registered in `shared/analytics-events.ts` and emitted through
`track()` (the ratchet test forbids raw `posthog.capture`). Props are enums,
booleans, and counts **only** — never command text, output, paths, workspace
dirs, OS usernames, or consent tokens.

| Event | Fires |
| --- | --- |
| `computer_engine_selected` | Local⇄Cloud toggle moved (`engine`) |
| `local_computer_consent_gate_shown` | consent gate rendered (`cloud_offered`) |
| `local_computer_consent_granted` | Allow (`outcome: stored \| failed`) |
| `local_computer_consent_denied` | "Use cloud instead" — the only decline affordance |
| `local_computer_consent_reauthorized` | "Forget & re-authorize" |
| `computer_terminal_opened` | a terminal pane mounted (`location`) |
| `local_terminal_unavailable` | terminal offered but degraded (`reason`) |

**Scoped out of v1:** a per-command `local_bash_result` event. No client code
reads a tool's `exitCode` today, a render-time emit would multi-fire across
re-renders, and outcome data already lands in the local JSONL journal
(`~/.mcpjam/computer/logs/commands.jsonl`). Add it as a fast-follow if a launch
gate needs the local success rate.

### Flag targeting

`deployment` (`"hosted" | "self_hosted"`) is registered as a **super property**
(rides events) *and* set as a **person property for flags**
(`setPersonPropertiesForFlags`, plus `identify` person properties). Super
properties alone are invisible to `/flags`, which evaluates person properties —
that is why both exist. `platform` is set alongside it.

The rollout rule itself is a **dashboard operation**, not code:

> `computers-enabled` → employees ∪ (`deployment = self_hosted` AND signed in)

## Launch / rollback checklist

**Owner:** whoever runs the launch (currently @marcelo).

Pre-launch:

- [ ] Flag `computers-enabled` rule set to employees ∪ `deployment = self_hosted`
      signed-in cohort; dry-run the targeting against a known self-hosted
      distinct_id before widening.
- [ ] Confirm `deployment` shows up as a **person** property (not only as an
      event property) in PostHog for a fresh browser profile.
- [ ] Confirm the consent funnel is intact:
      `local_computer_consent_gate_shown` → `_granted` / `_denied`, with zero
      command content on any event.
- [ ] Dev-run the happy path: consent → "This machine" → `uname -a` in chat runs
      locally and the tool card reads "this machine"; the Playground rail's
      engine chip agrees; the composer's computer-upload path is inactive.
- [ ] Terminal: open from the Computer tab → a real PTY in
      `~/.mcpjam/computer/<projectId>`; `echo $E2B_API_KEY` is empty; drag-drop
      over the local pane does nothing.
- [ ] Degrade: rename the `node-pty` module → the tab shows the terminal-off
      note and chat bash still works.
- [ ] Hosted build: the mint 404s, the WS route is unmounted,
      `terminalAvailable` is false.
- [ ] Packaged Electron: the build succeeds and the app degrades cleanly (no
      crash) with no terminal.
- [ ] macOS `npx` smoke via the packed tarball.

Rollback:

- [ ] Turn the flag off — this is the fast lever, and it governs hosted UI
      exposure.
- [ ] For a specific self-hosted server: set
      `MCPJAM_LOCAL_COMPUTER_ENABLED=false` and restart.
- [ ] For already-published npx/Electron clients: **cut a patch release.** No
      server-side switch reaches them.

Follow-ups (explicitly not in this program):

- [ ] Publish the user-facing page at `docs.mcpjam.com/inspector/*` — that
      content lives in the **separate Mintlify repo**, not in this `docs/`
      directory, which is engineering notes only.
- [ ] Real Electron terminal support (`extraResource` + custom node-pty
      resolution).
- [ ] `local_bash_result` per-command outcome event, if the launch gate needs
      the rate.
