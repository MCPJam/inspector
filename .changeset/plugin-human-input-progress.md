---
"@mcpjam/sdk": patch
"@mcpjam/widget-react": patch
"@mcpjam/inspector": patch
---

Keep app tool calls alive while their owned form or approval awaits a person, using the caller's progress token. Preserve ordinary tool deadlines, stop progress on cancellation or completion, and show the server name in owned forms. Send progress only on the original connected request transport. Keep global legacy forms visible in Compare and extend only their matching App request while the owned form is pending.
