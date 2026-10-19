---
"@mcpjam/inspector": patch
---

When one of a plugin's servers still needs your sign-in or setup, a Playground chat now runs the plugin's skills and its other servers instead of skipping the whole plugin, and says which plugin ran without a server. That server's card reads "Needs sign-in" or "Needs setup" instead of "Active". An older backend that can't report servers one by one is asked the previous way.
