---
"@mcpjam/inspector": patch
---

`DO_NOT_TRACK` now also stops the `/tlm` telemetry relay and server-side feature flag evaluation, and reaches the browser through the runtime config, which then starts Sentry disabled and PostHog opted out. Feature flags can come from `MCPJAM_FEATURE_FLAGS_FILE`, a JSON file of flag answers used instead of PostHog; with `DO_NOT_TRACK` and no file, every flag is off.
