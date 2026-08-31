---
"@mcpjam/sdk": patch
---

Raise the SDK build's heap ceiling so the dts pass stops dying.

tsup's dts worker peaks around 4.1GB, just over Node's 4192MB default on the
release runner, so the SDK build failed intermittently with an out-of-memory
abort. The build now runs under `cross-env` with an 8GB `max-old-space-size`,
which works on Windows runners too.
