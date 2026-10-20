---
"@mcpjam/inspector": patch
---

A plugin's local server is checked before it starts. It is refused if its working directory resolves outside the plugin's files and data folder, including through a symlink. A missing runtime such as `uvx`, or a bundle command that is missing or isn't executable, is reported by name instead of as a failed launch.
