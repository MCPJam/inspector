---
"@mcpjam/sdk": minor
---

Mock servers can be read in bounded pages. `get_mock_server` takes `family`, `name`, `path`, `search`, `limit` and `cursor`: a page of the changes, a page of names, one entry, or one field, with an oversized string in ordered chunks. Cursors are opaque and bound to the version, the caller and the read. `@mcpjam/sdk/mocks` adds `changeEntries` and `readMockView`.
