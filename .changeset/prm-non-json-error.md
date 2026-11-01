---
"@mcpjam/sdk": patch
"@mcpjam/inspector": patch
---

OAuth: when a server answers the protected resource metadata URL with a 200 that is not JSON (like an HTML landing page), the step now says "Protected resource metadata is not valid JSON (got text/html)." instead of the raw "Unexpected token '<'" parser error.
