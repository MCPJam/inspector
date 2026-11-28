---
"@mcpjam/inspector": patch
---

An iteration's evaluator results list code evaluators on their own, Required apart from Advisory, each with its reason and its logs under the script's file name. A Required code evaluator that errored marks the iteration unresolved and left out of the pass rate instead of failed, and every code evaluator error says it isn't counted as a failure.
