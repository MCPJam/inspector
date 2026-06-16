---
"@mcpjam/inspector": patch
---

Render the read-only share-usage thread transcript via the new
`@mcpjam/chat-ui` `ReadOnlyTranscript` — the first inspector adopter of the
Tier A package — replacing the interactive `TranscriptThread` on that
read-only surface. `@mcpjam/chat-ui` is resolved from source via vite/vitest/
tsconfig aliases (mirroring the SDK pattern) so no chat-ui build is required.
