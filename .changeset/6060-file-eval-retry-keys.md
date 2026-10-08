---
"@mcpjam/cli": patch
"@mcpjam/sdk": patch
---

Each `cloud eval run --file` invocation starts a new run unless `--idempotency-key` is supplied. The CLI prints the retry key before launch and includes it in receipts and launch errors; replayed runs are marked `deduped` in the receipt and human output. Repeating a file command without a key can now start and bill a second run, while retrying with the printed key safely reuses the first.
