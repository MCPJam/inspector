---
"@mcpjam/inspector": patch
---

Error cards can be copied, and their text selected

Highlighting the text on an error card was impossible wherever the card sits in
a surface that owns the drag gesture. On the servers grid, dnd-kit spreads its
sortable listeners over the whole card, and once the 8px activation distance is
crossed the sensor wipes the selection on every `selectionchange` — dragging
across the message reordered the card instead of selecting a word of it. In the
OAuth flow the card renders inside a ReactFlow node, and `.react-flow__node`
sets `user-select: none`, so there was nothing to drag for in the first place.

The card now stops the pointerdown from reaching those surfaces and carries
`select-text nodrag nopan`. A Copy button beside "Show details" puts the whole
failure on the clipboard as plain text — title, one-liner, likely causes, next
steps, raw error and cause — including the details while they are still
collapsed, since expanding them first to copy them defeats the point. A
clipboard that refuses the write says "Copy failed" instead of claiming success.
