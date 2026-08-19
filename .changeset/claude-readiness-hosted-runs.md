---
"@mcpjam/sdk": patch
"@mcpjam/inspector": patch
---

Claude readiness: hosted runs, and the v1 API that queues them.

A readiness run now has a hosted path. `POST /v1/projects/{p}/servers/{s}/claude-readiness-runs`
queues a durable run and answers `202`; a worker on some inspector node claims
it, grades the connector, and posts the result back. The run is polled through
`GET …/claude-readiness-runs/{runId}` and can be stopped with `…/cancel`.

ASYNCHRONOUS ON PURPOSE. A run dials somebody else's server, traces its
redirects, reads its metadata and opens an MCP connection — tens of seconds on
a healthy target and longer on a sick one. Running that inside the POST would
put a third party's latency on the caller's request timeout and lose the whole
grade when a proxy gave up first.

THE URL IS NOT A REQUEST FIELD. The run grades the connector as it is SAVED, so
the URL comes off the server record. A caller who could name a URL here would
file a grade against a connector the project never described. Grading an
arbitrary URL is what the CLI's `mcpjam claude readiness` is for — it runs on
the caller's own machine.

The worker dials through the DNS-pinned streaming transport rather than the
global fetch. Every URL a readiness run reaches after the first is chosen by
somebody else: the redirect chain, the `resource_metadata` pointer and the
authorization server all come out of the target's own responses, which on a
hosted node is exactly the SSRF surface the pinned transport exists for.

`runClaudeReadiness` takes an `AbortSignal`, and cancelling a run uses it. The
point is the TARGET rather than our bookkeeping: a cancelled run that keeps
probing is still dialling somebody else's server after the person who started
it asked it to stop, and "we stopped waiting for the answer" is not the same as
"we stopped asking".
