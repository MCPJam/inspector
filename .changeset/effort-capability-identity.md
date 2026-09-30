---
"@mcpjam/inspector": patch
---

Reasoning effort is now part of a saved model's identity in the client. An effort-only edit to a host's model now enables Save (it used to read as "unchanged"), the environment composer treats two efforts of one model as different compositions, and a named environment is reused only when its saved effort matches the cell's. Hosted model rows also carry the catalog's `supportedReasoningEfforts` (the model catalog cache moves to v4), and `reasoningEffortOptions` gives pickers the efforts a control may offer. No new control is shown yet.
