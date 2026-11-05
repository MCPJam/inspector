---
"@mcpjam/sdk": patch
"@mcpjam/inspector": patch
---

When the local inspector's OAuth proxy cannot connect to the server under test (connection refused, reset or timed out), it now answers 502, or 504 for a timeout, with "The connection to the server failed" followed by Node's message and what to check, instead of a 500. When Node tried several addresses (`localhost` on Windows and macOS), the message lists them instead of being empty. In the Docker image, a `localhost` or `127.0.0.1` target also gets a hint to use `host.docker.internal`. The OAuth Debugger shows the message without "Backend debug proxy error" and no longer reports it as an MCPJam error. Connecting to an OAuth server shows the same message for token and registration requests, and "HTTP 502" (or 504) instead of "HTTP 500" when its metadata cannot be fetched. The SDK adds `unreachableTargetFailure`, `isUnreachableTargetFailure` and `UNREACHABLE_TARGET_FAILURE`.
