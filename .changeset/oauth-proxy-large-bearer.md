---
"@mcpjam/inspector": patch
---

The hosted OAuth debugger now accepts access tokens up to 32 KiB. Large tokens, such as Microsoft Entra ID tokens that carry group claims, used to fail the final authenticated request with "Invalid request header". Other request headers keep the 8 KiB limit.
