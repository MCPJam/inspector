---
"@mcpjam/inspector": patch
---

The step-by-step case editor (Evaluate, behind `evaluate-observe-first`) now offers **Expect a tool call** under every prompt, not only under one that already has a tool. Choosing a tool writes it into that prompt's own steps, so it is graded against that prompt's turn. A case that says no tool is called, a pinned-first case, and a read-only view do not offer it.
