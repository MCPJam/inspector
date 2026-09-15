---
"@mcpjam/chat-ui": minor
"@mcpjam/inspector": patch
---

Sessions transcripts now read like the Playground. Two views of the same conversation had drifted into looking like two products: Sessions drew a generic `MessageCircle` bubble in front of every assistant response and rendered tool payloads as monochrome text, while the Playground did neither.

`showAssistantAvatar` now defaults to `false`, matching the Playground and Chat renderer, which has never drawn one. **This is a behaviour change for embedders**: a host that wants an avatar opts in and supplies a real one through `renderAvatar` — the seam is still there, what is gone is spending a gutter on an icon that identifies nothing.

`JsonView` colours a payload with the same tokenizer the Playground's `JsonEditor` uses. The tokenizer moved into `@mcpjam/chat-ui` (`tokenizeJson`, `highlightJson`, `formatPath`) and the inspector's `ui/json-editor` re-exports it, so the two surfaces colour from one token stream rather than from two implementations free to diverge. Highlighting is lossless — the block still renders exactly the text `FoldedBlock` measured — and a payload that is not a JSON object or array, or is larger than 100k characters, renders as plain text rather than being forced through the tokenizer.

`chat-ui/README.md` records which renderer is canonical for which kind of surface, so the next read-only surface reuses `ReadOnlyTranscript` instead of forking a third one.
