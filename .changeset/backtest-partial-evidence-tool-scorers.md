---
"@mcpjam/inspector": patch
---

The assertion backtest no longer lists the hosted tool-call scorers as not comparable for a negative test, or for a case with no expected tool calls, when the frozen case is missing its other field. Either fact alone means the runner declares neither scorer.
