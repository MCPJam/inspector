---
"@mcpjam/inspector": minor
---

Registry: clicking a Claude-directory card now opens a detail dialog showing the full upstream listing — long description, published tool and prompt names, publisher and links, categories, access notes (permissions, sensitive data, required fields), and the endpoint it connects to. The body is fetched per card from the catalog's stored upstream row (`getCatalogServer` with `includeRaw`), so the list itself stays blob-free.
