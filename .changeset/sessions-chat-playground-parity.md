---
"@mcpjam/chat-ui": minor
"@mcpjam/inspector": patch
---

Sessions transcripts now read like the Playground. Two views of the same conversation had drifted into looking like two products: Sessions drew a generic `MessageCircle` bubble in front of every assistant response and rendered tool payloads as monochrome text, while the Playground did neither.

**Avatar default changed.** `showAssistantAvatar` now defaults to `Boolean(renderAvatar)` instead of `true`, on `ReadOnlyTranscript`, `Transcript` and `MessageView` alike. A host that passes `renderAvatar` still gets its avatar with no second prop; a host that passes neither no longer gets a placeholder that identifies nothing. To keep the old behaviour, pass `showAssistantAvatar` explicitly — with no `renderAvatar` it renders the built-in bubble as before.

**`JsonView` now emits CSS classes.** It colours a payload with the same tokenizer the Playground's `JsonEditor` uses, wrapping tokens in `json-key`, `json-string`, `json-number`, `json-boolean`, `json-boolean-false`, `json-null` and `json-punctuation` spans. Colour requires importing `@mcpjam/chat-ui/styles.css`, which now ships rules for those classes at `.mcpjam-chat-ui .json-key` — two-class specificity. **A host already styling `.json-key` at one class will lose to it after upgrading**; raise your own specificity, or re-theme by overriding the `--json-*` custom properties on `.mcpjam-chat-ui`, which is the supported route.

Highlighting is skipped — the payload renders as plain monospace — unless the text parses as a complete JSON object or array, and for anything over 100k characters. The rule is stricter than "looks like JSON": NDJSON, a server-truncated payload, JSON with a trailing log line, trailing commas and BOM-prefixed JSON all render uncoloured. Rendering is lossless on every path, so those payloads are complete and foldable, just monochrome.

The tokenizer moved into `@mcpjam/chat-ui` and is published on the `@mcpjam/chat-ui/json-tokens` subpath (`tokenizeJson`, `highlightJson`, `formatPath`), so a consumer can take it without the renderer's React and markdown graph. `tokenizeJson` and `formatPath` are also on the main entrypoint. The inspector's `ui/json-editor` re-exports the subpath, so both surfaces colour from one token stream rather than two implementations free to diverge.

`FoldedBlock` accepts a function child (`(open) => ReactNode`) so a renderer whose cost scales with the payload can stay cheap while collapsed; a closed block keeps its children mounted, so highlighting them was building a full token tree for a few clipped lines. The tool card's Input and Output blocks use this. **Its Result block does not** — that renders markdown, whose cheap closed mode would show literal fence markers in the preview, so it still mounts eagerly. Under `attached-to-tool` traces a Result replaces Output entirely, so on that path only Input benefits.

`chat-ui/README.md` records which renderer to use for which surface: the inspector's where its store and context graph exists, `@mcpjam/chat-ui` where it does not. The Trace Viewer is listed as the read-only surface that stays on the inspector's renderer, since it keeps a live follow-up seam.
