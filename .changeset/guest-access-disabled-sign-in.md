---
"@mcpjam/inspector": patch
---

When the Inspector can't create a guest session, because guest access is off on the deployment or the network hit its daily limit, the page now opens signed out with a Sign in button. Before, it showed a loading spinner that never finished.
