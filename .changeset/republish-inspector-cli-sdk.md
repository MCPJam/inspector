---
"@mcpjam/inspector": patch
"@mcpjam/cli": patch
"@mcpjam/sdk": patch
---

Cut a fresh patch of @mcpjam/inspector, @mcpjam/cli, and @mcpjam/sdk.

The last release job reported `@mcpjam/sdk@8.7.0` as published, but that version never reached the npm registry — `latest` is still 8.6.0, while `@mcpjam/cli@5.7.0` and `@mcpjam/inspector@3.4.0` from the same run did land. This changeset is a version bump only, with no code changes, so the release job re-publishes the three packages together and the SDK on npm catches up with main.
