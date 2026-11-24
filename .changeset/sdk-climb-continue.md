---
"@mcpjam/sdk": minor
---

New platform operation `continue_climb` and its `continueClimb` client method: resume a climb MCPJam picks for after it paused. `start_climb` takes `picker: "mcpjam"` with `pickerModel`, and a climb now reports `pickerModel`, `stepRunner`, `step`, `paused` and `pickerSpend`; a round MCPJam picked reports `pickedBy` and `pickerChatSessionId`. `mcpjam cloud climbs continue` is the CLI command.
