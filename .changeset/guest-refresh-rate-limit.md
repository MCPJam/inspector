---
"@mcpjam/inspector": patch
---

A guest whose token refresh hits the per-network request limit no longer loses its session for ten minutes. The refresh now stops at the limit instead of retrying into it, and the app reconnects automatically when the one-minute window reopens.
