---
"@mcpjam/inspector": patch
---

A plugin server that needs your sign-in now has a Sign in button on its server card and in the plugin's Settings. It runs the same OAuth flow as a project server and brings you back to the page you started from. The callback stores your credential for that plugin server only: it no longer adds a standalone copy of the server to the project. Signing in to a plugin's server is available in the hosted app.
