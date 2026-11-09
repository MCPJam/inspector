---
"@mcpjam/inspector": patch
"@mcpjam/sdk": patch
---

Chat on a custom provider connection now runs with a saved reasoning effort instead of being refused: the effort is left out and a notice says so. A local-runtime organization connection also works when a stdio server or the local browser is selected, the hosted Inspector checks every request to a custom provider's base URL against its egress rules, and an organization that denies credential export can still use local-runtime connections in the hosted app. An Azure OpenAI base URL is now read as a resource only from its hostname, so a resource-shaped string elsewhere in the URL can't redirect the key.
