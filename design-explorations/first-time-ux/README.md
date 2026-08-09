# First-time user experience — design exploration

Working notes for the FTUE redesign. **The code in this branch is ahead of nothing and behind the design** — read the status section before building on it.

## The problem we found

Recorded from a cleared-localStorage guest session against a running dev server:

- First content on screen is a toast reading **"Finishing setup."** with an alert icon.
- The workspace then appears all at once — 12 nav destinations, a 10-control toolbar, three view tabs — with no orientation.
- The tool rail reads `Tools 0` and *"No tools found. Try refreshing and make sure the server is running."* — a troubleshooting instruction, before the user has done anything.
- The composer types `Draw me an MCP architecture diagram` character by character while three *different* starter chips sit above it under "Try one of these to get started".
- A hand-drawn arrow captioned *"Try this prompt with a demo MCP server"* renders underneath the toast, which covers it.
- Send stays disabled. The toast never leaves.

Root cause of the toast: `use-app-ready.ts` produces "Finishing setup." as a human-readable *reason* string for gating UI. The first-run connect fires before that gate passes, and the reason string is handed to the connection as its failure message. Console confirms:

```
{ serverName: "Excalidraw (App)", error: "Finishing setup." }
```

Separately, `use-onboarding.ts` defined a `connect_error` phase with a **Retry** toast action, but this failure arrives through the generic Connections channel, so that phase never fired and the retry affordance never rendered.

## Agreed direction

| | Decision |
|---|---|
| Placement | **Overlay on Home.** Not a route takeover — the app stays behind it. |
| Primary path | Connect your own server (URL or command, single field). |
| Secondary path | Excalidraw demo — **equal weight**, full-width, payoff named ("6 tools · no setup"). |
| Auth | Default `authType: "auto"`. On 401, resolve **inline** — Authorize, plus a "use a token instead" disclosure. Never hand off to the OAuth Debugger. |
| Own-server failure | Opens an editable detail form (name, transport, URL, auth, header), pre-filled. Secondary path there is Excalidraw. |
| Demo failure | Its own screen. No retry, no edit — the user typed nothing and can fix nothing. |
| Success | Brief success moment, then Playground with a **preloaded prompt** ready to send. |
| The "aha" | Different clients against one server. Real code allows 3 clients max to compare; auto-select Claude + ChatGPT + one more. |
| Sign-up | Guest bar under the Playground. Secondary/tertiary goal — never blocks. |
| Skip | Subtle link. Permanent for signed-in users; localStorage (per-browser) for guests. |
| Home | Persistent banner whenever no server, or only the demo, is connected. |

## Status of the code in this branch

**The code implements a full-viewport route takeover, which the design has since replaced with an overlay on Home.** The mounting point is wrong. What carries over unchanged:

- `client/src/lib/first-run-server-input.ts` — single-field parse into `ServerFormData` (HTTP vs stdio, name derivation, hosted-mode stdio rejection). 18 tests.
- `client/src/hooks/use-first-run-connect.ts` — connect state machine over `connectServerWithResult`, which returns structured `connected | failed | reauth | missing | superseded`. 14 tests.
- `client/src/components/first-run/FirstRunConnect.tsx` — choose / connecting / error states and their copy. 12 tests.

What must change: where it mounts (`App.tsx` early return → overlay on Home), plus the v3 additions not yet built — editable failure form, demo-down screen, success moment, preloaded prompt, guest bar, Home banner.

Tests were written against the takeover placement and will need revisiting with it.

## Unhappy paths

Seven buckets; five deserve distinct screens.

1. **Never leaves the browser** — empty input, `ws://`/`file://`, malformed URL, stdio in hosted mode. Inline field errors.
2. **MCPJam isn't ready** — issue #3352. Not a server failure; must never be dressed as one.
3. **Can't reach it** — DNS miss, refused, TLS, timeout, **CORS**. CORS needs its own copy: a server that works from a CLI can still refuse the browser origin, and generic "couldn't connect" sends people hunting the wrong thing.
4. **Wrong endpoint, right host** — 404, or a 200 returning HTML. The most likely typo outcome: pasting the marketing site instead of `/mcp`.
5. **Auth** — 401 with discovery metadata (OAuth) vs without (bearer only) vs **403** (authenticated but forbidden — re-running OAuth loops them, so offering it is a trap). Plus the OAuth flow failing on its own.
6. **Connected but empty** — handshake fine, `tools/list` returns zero. Not an error, but nothing to send.
7. **stdio** — command not found, process exits immediately, never speaks MCP, missing env.

## Open risks

- **Excalidraw is a single point of failure** for every new user without a server. The demo-down screen degrades gracefully, but a graceful dead end is still a dead end. A second demo — ideally one we host — removes the dependency.
- **403 and CORS have no copy yet.**
- **The capability grid is a table of protocol features.** It proves the aha cheaply, but running one prompt across three clients and seeing different behavior would land harder — and that's what the 3-client compare is for.
- **`#3352` is unverified on hosted.** Observed failing locally only; the code comment suggests it's specific to deployments that can't authenticate guests. If it also affects hosted, the demo path is unreliable for the real funnel.

## Prototype

`ftue-prototype-v3.html` — self-contained, dummy data, no backend. Open it directly in a browser.

A control rig at the top selects the simulated outcome (Connects · Can't reach · Not MCP · Needs OAuth · 0 tools). Any failure taken via the demo button shows the demo-down screen instead.

Client capability values in the Playground are **real**, read from `sdk/src/host-compat/catalog.generated.ts`:

| | Roots | Sampling | Elicitation | Extensions |
|---|---|---|---|---|
| Claude | – | – | – | ✓ |
| ChatGPT | – | – | – | ✓ |
| Cursor | ✓ | – | ✓ | ✓ |
| VS Code | ✓ | ✓ | ✓ | ✓ |
| Codex | – | – | ✓ | – |

These come from `host-compare-presets.ts`, which builds comparison subjects synthetically from the catalog — no host creation and no connection required, so the aha costs nothing to set up.
