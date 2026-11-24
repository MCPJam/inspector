---
"@mcpjam/sdk": minor
---

New platform operations `create_mock_server`, `update_mock_server` and `get_mock_server`, with the matching `PlatformApiClient` methods (`createMockServer`, `saveMockServerVersion`, `getMockServer`) and the `climbs` feature key. A mock sits in front of a saved server, or of nothing, with a definition that changes only what it states; saving takes a whole definition or a JSON merge patch with `expectedVersion`, and `dryRun` returns the change list without saving. Servers that are mocks carry `mock` in `list_project_servers`.
