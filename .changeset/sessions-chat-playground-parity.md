---
"@mcpjam/chat-ui": minor
"@mcpjam/inspector": patch
---

No generic assistant bubble in Sessions. `showAssistantAvatar` now defaults to `Boolean(renderAvatar)` instead of `true`, on `ReadOnlyTranscript`, `Transcript` and `MessageView` alike — so the `MessageCircle` placeholder that sat in front of every assistant response in a session transcript is gone, matching the Playground renderer, which has never drawn one. A host that passes `renderAvatar` still gets its avatar with no second prop. To keep the old behaviour, pass `showAssistantAvatar` explicitly — with no `renderAvatar` it renders the built-in bubble as before.

**`JsonView` now emits CSS classes.** The package's default JSON display colours a payload with the same tokenizer the Playground's `JsonEditor` uses, wrapping tokens in `json-key`, `json-string`, `json-number`, `json-boolean`, `json-boolean-false`, `json-null` and `json-punctuation` spans. This is the default path only — a host that passes `renderJson` (as the inspector does, supplying the Playground's collapsible tree) is unaffected. Colour requires importing `@mcpjam/chat-ui/styles.css`, which now ships rules for those classes at `.mcpjam-chat-ui .json-key` — two-class specificity. **A host already styling `.json-key` at one class will lose to it after upgrading**; raise your own specificity, or re-theme by overriding the `--json-*` custom properties on `.mcpjam-chat-ui`, which is the supported route.

Highlighting is skipped — the payload renders as plain monospace — unless the text parses as a complete JSON object or array, and for anything over 100k characters. The rule is stricter than "looks like JSON": NDJSON, a server-truncated payload, JSON with a trailing log line, trailing commas and BOM-prefixed JSON all render uncoloured. Rendering is lossless on every path, so those payloads are complete, just monochrome.

The tokenizer moved into `@mcpjam/chat-ui` and is published on the `@mcpjam/chat-ui/json-tokens` subpath (`tokenizeJson`, `highlightJson`, `formatPath`), so a consumer can take it without the renderer's React and markdown graph. `tokenizeJson` and `formatPath` are also on the main entrypoint. The inspector's `ui/json-editor` re-exports the subpath, so there is one tokenizer rather than two implementations free to diverge.

`chat-ui/README.md` records which renderer to use for which surface: the inspector's where its store and context graph exists, `@mcpjam/chat-ui` where it does not. The Trace Viewer is listed as the read-only surface that stays on the inspector's renderer, since it keeps a live follow-up seam.
