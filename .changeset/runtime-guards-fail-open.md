---
"@mcpjam/inspector": patch
---

Stop three `test:checks` guards from passing without inspecting anything.

`check:mcp-v1-runtime-imports`, `check:platform-runtime-safety` and
`check:platform-runtime-safety:dist` were `! rg …` expressions. That
construction fails OPEN: with no ripgrep on PATH the shell exits 127, `!`
inverts it to 0, and the step reports success having read no files. A renamed or
deleted scan root does the same thing — rg exits 2, `!` makes it a pass. So "I
ran" and "I found nothing" were indistinguishable, on three of the five steps in
the chain.

They are now one node program, like `check-bundled-runtime-paths.mjs` beside it:
no external binary to be absent, no shell negation to invert. A missing scan
root, a scan that reads zero files, and an unreadable path are each a FAILURE
rather than a skip, because each is a way of inspecting nothing while reporting
success. Violations are reported with the file and line instead of leaving the
reader to re-run rg by hand.
