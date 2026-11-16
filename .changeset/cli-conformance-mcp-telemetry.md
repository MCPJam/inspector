---
"@mcpjam/cli": patch
---

Anonymous telemetry for conformance runs now includes the suite family (`protocol`, `oauth`, `apps`, `tasks`, `events` or `run`), whether it was a single test or a suite, and the CLI version. `events conformance` now counts its runs too. `mcpjam mcp` sends one `cli_mcp_tool_called` event per tool call, with the name of the MCPJam tool that was called (such as `call_tool`), success, a safe error code and duration. It never sends tool names from the server under test, arguments, results or error messages. `--no-telemetry`, `DO_NOT_TRACK=1` and `mcpjam telemetry disable` turn all of it off.
