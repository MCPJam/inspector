---
"@mcpjam/inspector": patch
"@mcpjam/sdk": patch
"@mcpjam/widget-react": minor
---

Claude clients with plugin extensions list global Apps the way Claude does: the sidebar lists an App only when its tool is visible to the model, lists no quick actions, and lists but won't open a tool whose name has two underscores or dots in a row (or a dot next to an underscore), with a Logs entry naming the characters. A global App that can't go full screen opens inline at the top of a new chat instead of full screen. Claude on the web now turns on Sidebar Apps by default; Claude Desktop keeps it off. ChatGPT, Codex and every other client behave as before. `@mcpjam/widget-react` adds the `onFixedDisplayModeUnsupported` renderer prop, which lets a host take back an App that leaves out the display mode the host fixed.
