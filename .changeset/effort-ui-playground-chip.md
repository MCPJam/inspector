---
"@mcpjam/inspector": patch
---

Playground chat gets a reasoning effort chip beside the model picker (one shared `EffortControl`: a toggle group in a popover). The choice is remembered per model, defaults from a selected host's saved effort, is sent as a top-level `reasoningEffort`, and is restored when a chat is reopened. The chip is hidden when the model's capability is unknown and never offered for a harness turn; while an effort is set the temperature slider is disabled with an explanation and temperature is left out of the request.
