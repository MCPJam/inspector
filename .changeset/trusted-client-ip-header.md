---
"@mcpjam/inspector": patch
---

Self-hosted Inspector reads a client's address only from the header named in `MCPJAM_TRUSTED_CLIENT_IP_HEADER` when that variable is set, so a client can no longer pick its own rate-limit bucket by sending `CF-Connecting-IP`, `X-Real-IP` or `X-Forwarded-For`. A request carrying the edge secret keeps its Cloudflare address, and a value that is not one header name stops the server at startup.
