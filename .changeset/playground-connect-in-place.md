---
"@mcpjam/inspector": patch
---

Connect a server from the Playground without leaving it. The Tools rail's zero-server empty state offered a "Connect a server" button that navigated to Servers, so connecting a server dropped the user out of the Playground and they had to navigate back to use the server they had just connected. The button now opens the Add Server modal in place, the same one the composer's "+" menu and the header's Add Server button already use. Surfaces that mount the Playground state without a connect handler — the Evals embedded chat — keep the old navigation.
