---
"@mcpjam/inspector": patch
---

Suite settings can edit a suite's setup and cleanup scripts (Before the run, Before each iteration, After each iteration, After the run) on the Settings tab, and its grading box (files to copy from the agent's box, and network access) on the Default evaluators tab. Each row follows its own feature flag; with the flag off, a suite's existing scripts or grading settings show read-only and can still be removed. On an inspector that can't run MCPJam cloud sandboxes, Run says so before a suite with scripts or Required code evaluators is refused.
