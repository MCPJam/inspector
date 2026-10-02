---
"@mcpjam/inspector": patch
---

Playground chat gets a reasoning effort chip beside the model picker. The shared `EffortControl` is a slider popover: "Effort <Level>" with a `?` explainer, a Faster ↔ Smarter track with one stop per supported level, and a "Default" caption under the provider's default level (picking Default sends no effort). The chip shows the short level ("Med"). The choice is remembered per model, defaults from a selected host's saved effort, is sent as a top-level `reasoningEffort`, and is restored when a chat is reopened. The chip is hidden when the model's capability is unknown and never offered for a harness turn; while an effort is set the temperature slider is disabled with an explanation and temperature is left out of the request. Compare mode keeps the chip on every card: two cards of one model at Low and High are two cards, each sending its own effort (up to three), restored on reload.
