---
"@mcpjam/inspector": minor
---

`launchInspector()` and the Vite plugin can now share one MCPJam between dev commands. With `reuse: true` (the Vite plugin's default), a launch reuses your MCPJam already running on the port, and a started MCPJam stays up until the last dev command using it quits. The `server` you pass is added to your open, signed-in MCPJam tab, saved to the project it shows (or the one you pick when tabs differ), and removed when the dev command quits. `server` can now be a stdio command (`{ name, command, args, env }`). A taken port moves the launch to the next free one; new `port`, `strictPort` and `open` options control that and the browser. Existing calls that pass none of the new options keep their `process` handle.
