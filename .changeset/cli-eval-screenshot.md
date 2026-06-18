---
"@mcpjam/cli": minor
---

Add `mcpjam eval screenshot` to view the widget screenshot an eval iteration
rendered.

`eval screenshot --run <id> --iteration <id> --project <id>` pulls the rendered
`widgetRenderObservations` out of the iteration trace and shows the image
**inline** when the terminal supports a graphics protocol (iTerm2/WezTerm via
OSC 1337, Kitty/Ghostty via the Kitty graphics protocol), and otherwise prints
the image URL — so it degrades cleanly in plain terminals, pipes, and CI. Pass
`--out <file|dir>` to save the PNG(s) to disk instead, `--index <n>` to pick one
render. JSON output (default off-TTY) emits a structured `items[]` of
`{ toolName, toolCallId, status, screenshotUrl, savedTo? }`. Inline rendering is
dependency-free; no image libraries are added.
