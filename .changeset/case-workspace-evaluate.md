---
"@mcpjam/inspector": minor
---

Evaluate case workspace: write the case on the left, inspect one selected trial on the right

The Evaluate simple form now authors prompt → in-app steps → checks in the order they run (the write-back preserves executor order), recording starts only from an explicit click, the right column is resolved by one pure precedence function, a History pick freezes the form on that trial's snapshot until Edit case, and a "Next run" sheet separates what is saved with the case from what applies to one run. `/evals` is unchanged.
