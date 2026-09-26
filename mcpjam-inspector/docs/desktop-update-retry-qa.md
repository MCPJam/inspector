# Desktop update download recovery QA

Downloads retry twice after native errors, after 30 seconds and 2 minutes of
awake/online time. The 20-minute deadline is per download/check attempt and
excludes known system sleep and offline intervals. Connectivity is sampled every
30 seconds; an online result is not proof that the update server is reachable.
A timeout does not cancel Electron's native download. It exposes **Relaunch to
retry** rather than starting another native download in the same process.

## Automated checks

From `mcpjam-inspector/server`, run:

```sh
../../node_modules/.bin/vitest run --config vitest.config.ts __tests__/update-listeners.test.ts __tests__/update-attempt.test.ts __tests__/update-reporting.test.ts
```

From `mcpjam-inspector`, run:

```sh
../node_modules/.bin/vitest run --config client/vitest.config.ts client/src/hooks/__tests__/useUpdateNotification.test.ts client/src/components/sidebar/__tests__/sidebar-invite-cta.test.tsx
npm run typecheck:client
```

## Development UI check

Run `npm run electron:dev`. In Electron's renderer DevTools, the development-only
`window.electronAPI.update.simulateUpdate()`, `simulateUpdateError()`, and
`simulateUpdateDownloaded()` controls exercise Downloading, Retry download, and
Relaunch to update. Click Retry download and confirm the toast disappears and the
button shows Downloading. Simulate completion and confirm relaunch is offered.
Development does not perform native update downloads or installations.

## Signed macOS release-environment check

Use disposable, correctly signed test packages and a controlled update feed in a
QA-only build. Keep the signing identity consistent across the two versions.
Do not alter the production feed or publish a test release to production.

1. Return a native download error twice, then serve a valid update. Check the
   30-second and 2-minute delays, no failure toast during retries, and no app quit.
   After download, click Relaunch to update and verify the new version launches.
2. Fail all three downloads. Check the persistent toast and Retry download
   button. Restore the feed, click Retry, and confirm a successful download
   without closing the app. Double clicks must not start parallel downloads.
3. Hold a native download open for 20 awake/online minutes. Check Relaunch to
   retry. Click once and confirm one normal quit/reopen and a new download,
   without automatic installation. Fail that download again; no restart loop.
4. Instead of clicking relaunch, finish the stalled download late. The toast
   must disappear and Relaunch to update must become available.
5. Sleep the Mac for more than 20 minutes during a download. Wake it and confirm
   no immediate timeout. Disconnect/reconnect the network during both a download
   and backoff; only awake/online time should use the remaining allowance.
6. Reopen during retry backoff and during a retried download. Confirm the stored
   retry budget remains spent and downloading does not grant install permission.
7. Exercise the existing native installation-failure recovery. Confirm at most
   one native install call per process, version verification after relaunch, and
   force-quit instructions only if normal shutdown remains stuck.

## Reporting and limits

Exhausted retries and stalled downloads produce deduplicated error events in the
existing desktop Sentry project. Intermediate retries only log locally. Successful
recovery produces an info event. Metadata includes attempt ID, install/download
intent, retry counts, active download time, sleep time, and offline time; raw native
errors, user identity, feed URLs, and OAuth breadcrumbs are excluded.

The observed production events establish timeouts, not their underlying cause.
Sleep handling prevents one source of false timeouts; the new timing fields help
separate sleep/offline delays from actual active-time stalls.

This change was unit-tested with mocked Electron/Squirrel. The implementation
machine has no valid macOS code-signing identity, so the signed native update
smoke test remains a release-environment validation requirement.
