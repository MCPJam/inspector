---
"@mcpjam/inspector": patch
---

A deployment can give in-flight work time to finish on shutdown: with `MCPJAM_SHUTDOWN_DRAIN_MS` set, the server stops taking new claimed jobs and waits up to that long before closing connections, clamped to the platform's stop window when `RAILWAY_DEPLOYMENT_DRAINING_SECONDS` is set. Off by default.
