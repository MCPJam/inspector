---
"@mcpjam/sdk": minor
---

`@mcpjam/sdk/mocks` now exports `findUncallableInputs`, which finds the tool edits of a mock definition that leave the real tool impossible to call with valid input, such as a required real parameter that is hidden with no fixed value. Each issue has the code `uncallable_input`, the field path and what to change.
