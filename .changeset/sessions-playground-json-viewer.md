---
"@mcpjam/chat-ui": patch
"@mcpjam/inspector": patch
---

Sessions now shows tool input and output in the same collapsible JSON tree the Playground uses, instead of a plain preformatted block. Objects and arrays collapse, deep payloads open two levels and stop, long strings truncate with a control to see the rest, and every node has its own copy button.

`@mcpjam/chat-ui` gains a `renderJson` seam on `Transcript` / `ReadOnlyTranscript` / `ToolCallPart`. It is how the inspector hands in a viewer that lives one layer up rather than this package growing a second copy of it; omitted, the package renders exactly what it did before. Unlike `renderTool` and `renderWidget` it is available on `ReadOnlyTranscript`, because it can only swap one presentation of a value for another.

The readable result a trace adapter produces still goes through Markdown, and large payloads still fold — the tree is what you get when you open one.
