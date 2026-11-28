---
"@mcpjam/sdk": minor
"@mcpjam/inspector": patch
---

A failed first connect now shows the catalog's cause and steps with one button for the first fix. `describeError` accepts `{ phase: "connect" }`, which files an unclassified failure under `connect/unclassified`, and classifies a stdio command that cannot start as `transport/spawn_failed`. The hosted app stops a stdio command or a localhost URL before submit and offers the desktop app or an npx command.
