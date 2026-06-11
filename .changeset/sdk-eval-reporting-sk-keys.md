---
"@mcpjam/sdk": minor
---

SDK eval reporting now works with standard `sk_` API keys via new `/api/v1/eval-ingest` proxy routes on the inspector server. `reportEvalResults` migrated to use the platform API client; the `eval-reporting-types` and `eval-run-reporter` exports are extended to cover the ingest payload. Docs for running evals and saving results are un-retired.
