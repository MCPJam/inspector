# Telemetry containment for credential URLs

Vendor-side settings that contain credential URLs (share links, handoff links,
OAuth and sign-in callbacks, secret query keys) sent by builds that predate
client-side scrubbing. They are generated from the credential-URL registry,
`mcpjam-inspector/shared/credential-urls.ts`, by the same pattern builders the
daily leak monitor uses (`ops/credential-leak-monitor/`).

These settings are **containment, not prevention**. Current builds do not send
credentials (every telemetry exit scrubs with the registry, and payloads that
cannot be shown clean are dropped). Desktop apps installed before that change
keep their old code until they auto-update; these settings cover them.

| Setting | Where | Effect | Before or after capture |
| --- | --- | --- | --- |
| `session_recording_url_blocklist_config` | PostHog project settings (Replay → URL blocklist), or the project API | posthog-js reads it from remote config and does not record while the page URL matches | **Before**: the recording never happens, old builds included |
| Advanced Data Scrubbing rules | Sentry: Settings → Security & Privacy → Advanced Data Scrubbing, on the `inspector-client`, `inspector-electron` and `inspector-server` projects | Replaces the secret with `[redacted]` in every string of an ingested event | After transmission |
| Ingestion transformation (Hog) | PostHog: Data pipelines → Transformations | Drops an event whose URL properties still carry a credential | After transmission |

## Generate

```bash
node ops/telemetry-containment/build.mts posthog-blocklist       # JSON for the project setting
node ops/telemetry-containment/build.mts sentry-pii              # Relay PII config JSON
node ops/telemetry-containment/build.mts posthog-transformation  # Hog source
```

Node 22.6+ runs `.mts` directly (add `--experimental-strip-types` before Node
23.6). `build.mts` only prints; nothing here calls a vendor API.

## Apply

Changing production vendor settings needs an explicit go-ahead from the owner
of the PostHog and Sentry projects. Then:

1. **PostHog blocklist.** Paste each entry into the replay URL blocklist with
   matching set to *regex*, or `PATCH /api/projects/<id>/` with
   `{"session_recording_url_blocklist_config": [...]}`. Check in a replay of a
   normal page that recording still works, and that opening a `/results/…`
   link in a fresh session produces no recording.
2. **Sentry rules.** In each of the three projects, add the rules from
   `sentry-pii` (Advanced Data Scrubbing → raw JSON). Send a test event whose
   message contains `/results/abc123` and confirm it arrives as
   `/results/[redacted]`.
3. **PostHog transformation.** Create a Hog transformation with the generated
   source, run it in the transformation tester against an event with
   `$current_url: https://app.mcpjam.com/results/abc123` (dropped) and one with
   `/p/x/servers` (kept), then enable it.
4. Re-run the leak monitor (`.github/workflows/credential-leak-monitor.yml`,
   manual dispatch) after 24 hours: old-build leaks should stop appearing in
   Sentry; PostHog events from old builds stop being stored.

When a route is added to the registry, regenerate and re-apply. The test
`mcpjam-inspector/shared/__tests__/telemetry-containment.test.ts` holds the
generated settings to the registry, so they cannot silently miss a route.
