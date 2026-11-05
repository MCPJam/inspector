---
"@mcpjam/sdk": patch
"@mcpjam/inspector": patch
---

The OAuth debugger no longer reports an authorization server's refusal of Dynamic Client Registration (any non-2xx answer to the registration request) as an MCPJam error. The message still shows on screen, and a failure of the debug proxy itself still reports. The SDK adds `isDynamicClientRegistrationHttpError` to spot it.
