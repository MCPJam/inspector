---
"@mcpjam/inspector": patch
---

Ask MCPJam works again for signed-in users on npx and the desktop app. Since v3.12.2 every turn on a local install (npx, Docker, the desktop app, or a source checkout) failed with "INSPECTOR_SERVICE_TOKEN is not set, so this server cannot attest an MCPJam-paid agent turn". The agent's turns and its web search now run on your own sign-in, with no server token to configure.
