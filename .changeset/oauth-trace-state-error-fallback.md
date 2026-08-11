---
"@mcpjam/sdk": patch
---

Redact the `state.error` fallback in OAuth trace projection.

`projectOAuthTraceSnapshot` read `state.error` in three places and only sanitized two of them. The unsanitized one is the step-level fallback: when the failing step already has an `httpHistory` entry, `inferHttpHistoryEntryError` returns nothing (it only mines responses for `request_client_registration`), the "no entry for the current step" branch is skipped because the entry exists, and the step's `error` fell through to the raw string. An authorization server that echoes a credential back in `error_description` landed it verbatim in rendered, copied, and persisted traces.

The projection of `state.error` is now computed once, next to the snapshot's own `error` field, and every consumer reads that variable. `state.error` is read raw exactly once in the file, so the redaction policy has a single place to keep in sync rather than three branches to remember.
