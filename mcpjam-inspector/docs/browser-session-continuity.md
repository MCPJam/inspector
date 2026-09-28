# Conversation browser continuity — first release

Implements stages 0–1c of the browser session persistence plan. Returning to a
conversation attaches to its existing live browser. It does not navigate, create a
replacement, or hand control back to the agent. New/Clear chat creates a new owner;
closing the browser pane only detaches that viewer.

## Identity and attachment

- `chatSessionId` is the conversation owner key; it is not a Convex document ID.
- The session service resolves that key to `browserLogicalSessions._id` before
  binding a cloud sandbox or recording a boot. Hostless conversations use this same
  resolver and a trusted Inspector admission, never the project computer fallback.
- The logical record pins the engine. An engine mismatch is refused before launch.
- A sandbox row identifies the machine; `bootId` identifies the running daemon.
- The pane keys visibility, shell state, token cache, queued input and stale-response
  rejection by the selected conversation/attachment. Background tool calls only open
  their own conversation's panel.

`POST /api/mcp/computers/local-browser/lookup` requires local consent and reads the
existing runtime. It never launches, navigates, copies a profile or acquires control.
Foreground empty panes poll with bounded backoff; hidden panes do not discover or
wake a browser. Hosted token minting and ordinary session reads also never provision.
The explicit connect action may wake the already-bound snapshot.

## Safe cleanup and resume

Local foreground presence renews for 45 seconds. A human hold, in-flight operation,
or foreground viewer prevents automatic cleanup, including the absolute age limit.
The daemon closes command/input admission synchronously before disposal. Parked
control still blocks agents but does not reserve compute indefinitely.

Cloud sleep uses an authenticated, boot-qualified `/v1/lifecycle` pause barrier.
The daemon refuses while commands/input or a human hold are active. The backend
claims each pause, verifies bounded foreground presence, asks the provider to pause,
then settles billing. Wake reopens admission for that same operation and boot.
The Inspector separately verifies browserd readiness and boot identity before
reattachment. A failed/missing existing boot is reported unavailable and is never
silently replaced. No page tools or navigation are replayed after that failure.

Detaching stops this viewer's heartbeats. It does not resume the agent; lease expiry
remains parked, and Hand back is explicit.

## Rollout and validation

Deploy the paired backend changes before the Inspector. The daemon bundle is included.
Old daemons without `/v1/lifecycle` safely refuse automatic pause and stay billable;
explicitly end/reopen those sessions to obtain the new bundle. Never hot-replace a
healthy held browser. Unknown provider pause outcomes keep the barrier and metering;
confirmed suspended status reconciles them. Automatic replacement/fencing is deferred.

Tests cover conversation switching including A → B → A, ownerless admission, real
Convex resolver/bind validation, foreground expiry, paused billing, busy/held refusal,
uncertain pause reconciliation, same-boot resume, and retained boot credentials.

Run actual Chromium continuity locally from the Inspector package:

```sh
RUN_BROWSER_CONTINUITY_E2E=1 npx vitest run server/services/browserd/local/__tests__/continuity.integration.test.ts
```

This launches two temporary isolated browser contexts, checks JavaScript memory,
unsaved form text, scroll, tabs and boot identity, and removes its profiles afterward.
Hosted E2B and a running Electron app still require a controlled staging/desktop
acceptance pass; mocked drivers are not evidence of real provider memory persistence.

Stages 2–4 remain separate: runtime-written checkpoints, explicit cold recovery and
boot-qualified replacement, saved-profile/wipe UX, and project/account deletion.
CLI permalinks and recordings are the companion cloud-agent-session program.
