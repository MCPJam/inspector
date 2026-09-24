---
"@mcpjam/sdk": patch
"@mcpjam/inspector": patch
---

Keep persisted conformance runs behind the hosted egress guard.

`runConformance`'s protocol suite now dials through the fetch attached to the server config — `fetchFn`, then `baseFetch` — which is what the apps and tasks suites of the same run already did. It rebuilt its config from the URL, token and headers alone, so a caller's fetch never reached it and the suite, raw probes and MCP client both, fell back to the global `fetch`. An explicit `protocol.fetchFn` still wins.

In the hosted inspector, every persisted conformance run — the public `/v1` start route, the GitHub checks worker and the benchmark worker — now dials through the DNS-pinned, hop-by-hop egress guard whoever starts it:

- the executor defaults the MCP and OAuth transports to the hosted conformance guard when a caller passes none, and both workers now pass it explicitly instead of a bare `{ url }`;
- a target the guard refuses outright is never handed to a suite. The run records the refusal as each suite's could-not-run reason. This also covers the protocol suite's localhost host-header checks, which open raw sockets that no fetch can guard;
- a refused or failed dial reaches the stored report as the guard's verdict or one uniform message, never as the address a hostname resolved to or the socket, TLS or DNS error text;
- the GitHub-check health probe dials the pull request's server through the hosted MCP transport rather than the global `fetch`.

The CI guard (`check-hosted-manager-base-fetch.mjs`) now also scans `server/routes/shared` and fails when a hosted file imports an `@mcpjam/sdk` entry point that opens its own connection (`runConformance`, the conformance suites, `withEphemeralClient`, `probeMcpServer`, `runServerDoctor` and the like) without being listed with the guard it dials through.

Local and desktop behaviour is unchanged: every guard, the up-front refusal and the redaction are no-ops outside hosted mode.
