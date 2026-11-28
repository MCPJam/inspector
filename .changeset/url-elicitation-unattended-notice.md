---
"@mcpjam/inspector": patch
---

When a tool needs the user to finish something at a URL first (`-32042`), the model is told the user saw the link only when a chat actually showed it to someone. Evals, goal runs, event turns and API agent turns now tell the model that nobody could be shown the link, so it doesn't wait for, or report, a user action that never happened.
