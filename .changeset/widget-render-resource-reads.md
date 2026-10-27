---
"@mcpjam/inspector": patch
---

MCP Apps rendered headlessly (**Clients → Run live**, widget sessions and the `v1/widgets` API) can now read their own server's resources. These renders told the widget that reads were supported, then failed every `resources/read` with "Resource reads not supported", so a widget that loads its content that way showed an error.
