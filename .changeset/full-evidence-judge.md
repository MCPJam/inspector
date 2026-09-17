---
"@mcpjam/sdk": minor
"@mcpjam/cli": minor
"@mcpjam/evaluators": minor
"@mcpjam/inspector": minor
---

Use one versioned goal-completion judge contract across hosted evals and the SDK, with complete recorded traces, tool catalogs, runtime context and supported captured media. Add optional grading instructions, unscored evidence errors, durable per-iteration recovery, provenance and failed-only retries. Preserve custom judge definitions and existing explicit manual/off settings.

Expose bounded judge backtests through the SDK, CLI and MCP, with draft/source-bound continuation and cached page retries. Deploy the paired optional backend schema and handlers before publishing writers or enabling automatic grading. Grading is controlled by the suite's own settings.

**Data-egress change:** hosted v4 grading sends full recorded conversations and traces, tool schemas, runtime context and supported media bytes through OpenRouter to the selected model provider, with existing credential redaction. Review provider/data policies before enabling; explicit manual/off settings remain available on every suite.
