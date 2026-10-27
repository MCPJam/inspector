---
"@mcpjam/sdk": patch
"@mcpjam/inspector": patch
---

When the server under test presents a TLS certificate that Node.js does not trust, the local inspector's OAuth proxy now answers 502 with "The server's TLS certificate could not be verified" followed by Node's own message, instead of a 500. The OAuth Debugger shows that message without "Backend debug proxy error" and no longer reports it as an MCPJam error. The SDK adds `tlsTrustFailure`, `isTlsTrustFailure` and the `transport/tls_untrusted` error code.
