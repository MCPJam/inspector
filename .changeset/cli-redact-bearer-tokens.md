---
"@mcpjam/cli": patch
---

The "Using MCPJam Cloud as …" line shows only the last four characters of a credential that isn't an `sk_` style key, such as a JWT passed in `MCPJAM_API_KEY`. It used to print everything before the token's first underscore.
