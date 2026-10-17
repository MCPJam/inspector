---
"@mcpjam/sdk": minor
"@mcpjam/inspector": patch
---

The Platform API has two new error codes. `PAYMENT_REQUIRED` (402) means the organization can't pay for the work, and `details.reason` says why: `insufficient_credits`, `spend_budget_reached` or `wallet_locked`. `UPGRADE_REQUIRED` (426) means the client version is no longer supported, and `details.minimumVersion` names the version to install.

An exhausted organization spend budget now returns 402 `PAYMENT_REQUIRED` with `details.reason: "spend_budget_reached"` instead of 400 `VALIDATION_ERROR`. This covers eval launches, conformance runs and computer creation, and `mcpjam evals run` exits 4 instead of 2 for it.
