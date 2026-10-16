# Desktop update diagnostics

Existing desktop failure and recovery events include `contexts.update_diagnostics`.
Use the attempt ID to connect events. Diagnostics do not change installation,
retry, polling, or alert decisions. Routine successful background downloads still
stay quiet in Sentry; this is not a stream of every user's update activity.

- `trigger` identifies the original attempt trigger. Timeline entries distinguish
  later automatic retries, user retries, recovery restarts, and installation.
- `timestamps` contains Unix milliseconds for observed steps. `download_available`
  is Electron's notification, not proof of the first transferred byte.
- `attempt_elapsed_ms` is wall time since the recorded attempt start.
  `download_elapsed_ms` runs from the latest availability event to completion
  (or the snapshot if incomplete). `after_timeout_ms` runs from the latest timeout
  to completion (or the snapshot). These durations can overlap.
- `observed_ms` means observed awake/online time while awaiting the native result,
  including after timeout. It is **not** proof of network transfer. `sleep_ms`
  and `offline_ms` are observed exclusions. Connectivity is sampled every 30
  seconds; it does not establish release-server reachability.
- `unknown_ms` includes gaps between processes and unexplained gaps over 90 seconds
  between samples. Older/missing histories use `history: partial` and a null start.
- `timeline` contains up to 100 allowlisted JSON lines. Strings intentionally avoid
  Sentry's default nested-object normalization, which otherwise replaces steps with
  `[Object]`. No raw native messages, paths, URLs or inherited breadcrumbs are included.
- `byte_progress: unavailable` reflects Electron autoUpdater's lack of byte progress.
- `download_completed` only confirms a download. Check `launch_verification` and
  existing installation outcome fields to determine whether it installed.

Shutdown timelines include native installation, before-quit, browser/local cleanup,
blocked window closing and will-quit. A recovery restart has its own shutdown
sequence. Missing stages describe what was observed, not a proven root cause.

The separate `.update-diagnostics.json` in Electron's userData directory stores at
most 32 attempts atomically, with owner-only file permissions. It is never read as
authorization to restart or install. Corrupt/unreadable history logs a generic
warning and continues with partial history; write failures keep in-memory evidence.

Validation: focused tests cover timer independence and restart authorization.
A controlled `update-diagnostics-test` event was read back from Sentry with a fully
preserved timeline: event `7bf10c69f58c4dd9b72ea1ab7ec7233c`, issue `7781862317`.
The inspected Slack workflow `3827830` only applies to `prod`; searching the alert
channel found no controlled-test notification. No alert configuration was changed.
Signed macOS end-to-end update testing still requires a signing identity.

## Signed macOS harness qualification

`desktop-package-smoke.yml` checks an unsigned bundle. Its success does not
qualify a signed release, authentication, updating, or a local harness. Run the
following on a fresh installation of the exact signed and notarized candidate,
on every advertised macOS architecture. Signing and publication are human steps.

Before testing, record the installer SHA-256, app version, source commit,
macOS version and architecture, signing identity, notarization assessment, and
both runtime pack versions, tree digests and layer versions. Retain the native
signature-verification output with the report; a filename is not identity proof.
Use a disposable project and independent work folders for the two clients.

| Check | Required evidence | Initial status |
|---|---|---|
| Fresh install and first launch | Gatekeeper accepts the notarized app; executable signature verifies; displayed version matches the installer | not_run |
| Sign in and callback | Real browser sign-in returns to this installed app and the intended account; wrong or replayed callback is refused | not_run |
| Runtime installation | Claude Code and Codex packs download, verify and report the recorded exact identities; failed verification does not launch | not_run |
| Local turns and approvals | Each client performs a native write/read, exact fixture MCP call, and second-turn read; approve, deny, two approvals, reload and Stop each settle correctly | not_run |
| Update and restart | Install the candidate from the previous supported release; restart opens the candidate version, preserves settings and requires valid local authorization | not_run |
| Offline and recovery | Interrupted download or lost network has an actionable result; reconnect/retry completes once; an unverified partial pack never executes | not_run |
| Quit cleanup | Quit while running and while awaiting approval; app and native harness descendants terminate; relaunch reports no stale running session | not_run |

For each row, retain a short recording or command output, timestamps, session
and turn IDs, and the observed terminal state. For update rows include the
update attempt ID and its diagnostics timeline. For cleanup include a native
process-tree observation after the app exits, not only an empty UI list.
Mark a row passed only after observing its required behavior; retain failure and
`not_run` statuses. Never copy source-test or unsigned-bundle results into this
report. A changed installer or runtime pack invalidates the corresponding
candidate evidence and requires rerunning its affected cases.
