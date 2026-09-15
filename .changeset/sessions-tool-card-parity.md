---
"@mcpjam/chat-ui": patch
---

The session transcript's tool card now wears the same shell as the inspector's own: a header row with the MCP mark, the mono tool name, the call's state and a chevron, opening onto `INPUT` / `RESULT` headings over capped payload boxes. One product was showing a tool call two different ways depending on which tab you were in.

The whole card collapses and starts collapsed, replacing the per-payload fold — one header line per call, so a transcript reads as a conversation rather than a wall of JSON. A **failed** call opens itself: an error is the reason someone opened the session, not evidence to put behind a disclosure. `defaultOpen` overrides either way.

Not carried over: the inspector card's Inline / PiP / Fullscreen / Data / Sandbox / Edit toolbar, which drives a live widget and re-runs tools — against a recorded session there is nothing for it to act on. `FoldedBlock` is removed; nothing rendered it any more.
