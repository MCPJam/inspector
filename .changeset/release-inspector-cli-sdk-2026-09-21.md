---
"@mcpjam/inspector": patch
"@mcpjam/cli": patch
"@mcpjam/sdk": patch
---

Cut a fresh release of @mcpjam/inspector, @mcpjam/cli, and @mcpjam/sdk.

This changeset carries no code changes. It ships the inspector and SDK work that has been waiting on main since the last release, and bumps @mcpjam/cli in the same run so the published CLI depends on the new @mcpjam/sdk instead of the previous one.
