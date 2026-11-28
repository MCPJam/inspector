---
"@mcpjam/inspector": patch
---

The local web client sign-in window (`web-clients-local-tracer.ts --sign-in`) now opens Chromium as a plain browser instead of through Playwright, so claude.ai's human check no longer loops in it. Local web client turns drop Playwright's `--enable-automation` flag.
