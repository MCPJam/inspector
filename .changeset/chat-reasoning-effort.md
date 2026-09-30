---
"@mcpjam/inspector": patch
---

Playground chat now honours a reasoning effort instead of dropping it. A top-level `reasoningEffort` in the chat request (web and MCP `chat-v2`), or the selected host's saved effort when its selection is for the same model as the turn, is sent to the hosted `/stream` and org-cloud streams as a top-level field, applied as provider options on the direct and local-runtime routes, and handed to a harness adapter (which refuses an effort it has not verified). Under an effort the resolved temperature is omitted, and an explicit temperature sent with a body effort is refused on the direct routes. An unknown level is a 400. The effort is pinned on the chat's resume config so a reopened chat keeps it, and API chat sessions run under their host's saved effort.
