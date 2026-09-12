---
"@mcpjam/inspector": patch
---

Read WebMCP inspection frames with the same decoder the Playground browser panes use, and retire the fallback transports beneath it. Frames now travel on their own channel rather than the session event stream, so the timeline and tool panels no longer re-render as the page paints. The event stream no longer carries pixels, the `frames=off` query parameter and the screenshot poll are removed, and a pane whose frame socket cannot connect says live view is unavailable instead of quietly showing a stale picture. Turning live view off now also discards a frame still decoding, which could repaint the pane after it stopped watching, and a frame socket that connects after the browser has already crashed is closed rather than left open on a page that will never paint again.
