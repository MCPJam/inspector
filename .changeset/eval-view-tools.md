---
"@mcpjam/inspector": minor
"@mcpjam/sdk": patch
---

Evals can discover and call MCP App view tools under the suite tool policy. Dispatched view tools count toward assertions by their original names. Views stay mounted for a turn and views with tools carry across prompts; suites may therefore observe new calls or changed outcomes. Use `view:make_move` to allow or deny a view tool in a suite policy; unqualified server tool names are still validated before the run.

Do not warn about unmatched allow names that the runner explicitly defers until tools become available.
