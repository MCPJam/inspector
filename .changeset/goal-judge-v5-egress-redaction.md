---
"@mcpjam/sdk": patch
---

Redact personal data before the built-in goal judge reads it, the same way the hosted judge does.

The goal judge moves to template v5. Before the model sees a case, one redactor runs over the authored task and the recorded evidence together, replacing emails, card numbers, US SSNs, long numeric ids, phone numbers, IP addresses and URLs with placeholders such as `[email-a]`. A placeholder is consistent within one request, so a rubric that names an address and the trace that sent to it still match. The judge's system prompt explains the placeholders, and `evidenceHash` now covers the redacted evidence the judge actually read. The redactor and its credential rules are byte-identical copies of the hosted ones, pinned on the backend as mirror pairs, and the shared v5 fixture proves a local and a hosted request match byte for byte. Verdicts from v4 and v5 carry different template hashes and are not comparable. Person names and street addresses are not detected.
