---
"@mcpjam/sdk": patch
---

Widget evidence too large to send inline now goes to storage, so an MCP Apps server can report its evals.

Reporting a run embedded each widget snapshot's HTML in the request. A snapshot is a whole built app — a single-file bundle is commonly over half a megabyte — so one test case whose tool ran twice put more than 1MB on the wire and the upload failed with "Request body exceeds 1MB limit". Chunking could not save it: it splits between results, never inside one.

Small widgets still ride along inline, in the one request they always did, because that is what lets a retry resend identical bytes. Only a result that would not fit offloads its HTML to blob storage first and sends the id instead. The offload happens once, before the retry loop, so retries stay byte-identical either way.
