---
"@mcpjam/sdk": major
"@mcpjam/inspector": patch
---

Require a platform payment before each direct EvalTest iteration, including runs with uploads disabled. Declare `billableSteps` for callbacks that issue more than one prompt; the default is one. Callback retries reuse the payment, and attempts that exceed the declared count stop before the extra prompt.

Deploy the iteration-payment backend and Inspector proxy before publishing this SDK change. Result uploads carry payment receipts to avoid collecting the same fee twice.
