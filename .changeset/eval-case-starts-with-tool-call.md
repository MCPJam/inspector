---
"@mcpjam/inspector": patch
---

Record results for eval cases that start with a tool call. A suite run now finds each iteration's pre-created row by case, iteration and model instead of by the prompt text, so a `toolCall > prompt > assert` case no longer ends every iteration in "Worker heartbeat lost", and two cases with the same title and first prompt each record on their own row.
