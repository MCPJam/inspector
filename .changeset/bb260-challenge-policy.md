---
"@mcpjam/sdk": minor
---

Parse mid-session HTTP and tool-result sign-in challenges with a shared host policy. Preserve tool security declarations when the transport strips them. A bare `insufficient_scope` with no scope or metadata pointer is now a step-up challenge instead of an unrecognized error, and a challenge is read from error data only when it comes from an HTTP 401.
