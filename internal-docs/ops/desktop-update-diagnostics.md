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
