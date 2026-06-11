---
"@mcpjam/sdk": minor
---

`@mcpjam/sdk/platform` covers the eval and chatbox surface of the Platform API. `PlatformApiClient` gains `listChatboxes`/`getChatbox`, `createEvalRun`, `getEvalRun`, `listEvalRunIterations`, `getEvalIterationTrace`, and `listEvalSuiteRuns` (with matching wire DTOs). The curated operation catalog grows nine operations — `list_eval_suites`, `list_eval_suite_runs`, `run_eval_suite` (async suite rerun: resolves suites and servers by name or ID, defaults to the project's enabled HTTP servers), `get_eval_run`, `list_eval_run_iterations`, `get_eval_iteration_trace`, `list_chatboxes`, `get_chatbox`, and `list_chat_sessions` — and every operation now carries a `readOnly` flag, which downstream surfaces map to their own affordances (the MCP worker emits it as the `readOnlyHint` tool annotation).
