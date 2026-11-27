---
"@mcpjam/inspector": patch
---

A Claude web or ChatGPT web turn run from the local app no longer stops with "Nothing on the page matches" when a control renders a moment after the click that opens it, such as the **Add custom connector** menu item. The browser now waits up to 5 seconds for the control before reporting it missing.
