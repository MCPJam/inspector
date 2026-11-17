---
"@mcpjam/inspector": patch
"@mcpjam/sdk": patch
---

Reviewer sign-in fails closed. An attempt whose identity check was asked for but could not be made (the tool erred, its result lacked the field, or the reviewer's session failed) now fails instead of passing as unverified; only a submission that names no identity tool passes unverified. The sign-in stage passes only when MCPJam's callback carries a code, not when the page changes after the password.
