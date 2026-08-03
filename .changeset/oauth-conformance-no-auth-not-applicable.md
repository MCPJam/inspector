---
"@mcpjam/inspector": patch
"@mcpjam/sdk": minor
---

Stop reporting servers that require no authorization as OAuth conformance
failures.

A public MCP server used to fail the OAuth suite outright. The three modern
state machines already recognized a 200 on the unauthenticated `initialize`
and logged "Optional Authentication Detected", but nothing branched on it: the
flow advanced into `received_401_unauthorized` with no challenge header,
derived the well-known Protected Resource Metadata URL, 404'd, and the runner
recorded a hard failure — `OAuth conformance failed at
request_resource_metadata`. At suite level `results.every(r => r.passed)`
poisoned the whole run, and nothing distinguished "this server has no auth"
from "this server's auth is broken".

That is backwards. **Authorization is OPTIONAL for MCP implementations. When
supported:** is byte-identical in 2025-03-26, 2025-06-18, 2025-11-25,
2026-07-28 and draft, so every obligation the suite asserts is conditional on
the server having opted in. A server that never opted in has nothing to
violate.

The runner now opens with a pre-flight tokenless `initialize` — the discovery
trigger the spec itself defines ("Attempt unauthenticated MCP request" in the
2025-11-25 and 2026-07-28 discovery diagrams; 2025-03-26 states the server
obligation outright: "When authorization is required and not yet proven by the
client, servers **MUST** respond with _HTTP 401 Unauthorized_"). A 2xx means
authorization is not required and the suite reports the new
`outcome: "not-applicable"`; a 401 runs the suite as before. Anything else,
including a transport error, is inconclusive and still runs the suite, so a
broken server can never launder itself into "no auth required".

Detection is deliberately **not** keyed on `WWW-Authenticate`. From 2025-11-25
onward that header is only one of two permitted discovery mechanisms — a
conformant server may return a bare 401 and serve the well-known URI instead —
so a missing header says nothing about whether authorization is required. Only
the absence of a challenge does.

The probe runs on every version, including 2025-03-26, whose machine goes
straight from `idle` to `discovery_start` and never probes on its own. It
costs one extra `initialize` per run.

API changes on `@mcpjam/sdk`:

- `ConformanceResult.outcome: "passed" | "failed" | "not-applicable"`, with
  `passed` true only for `"passed"`. Suite aggregation, the human formatter
  (`NOT APPLICABLE` / `N/A`), and the CLI's exit code all treat a
  not-applicable flow as non-failing.
- `StepResult.skipReason: "not-applicable" | "could-not-run"`, mirroring the
  tasks suite. The two are not interchangeable: the first leaves nothing
  unverified, the second means an applicable obligation went untested. The
  existing bare skips are now labelled — the client_credentials PKCE and
  authorization-code steps as not-applicable, the redirect-mismatch check with
  no redirect URL as could-not-run.

In the inspector, a not-applicable OAuth suite renders with the existing
"unavailable" treatment and its reason, rather than as a red failure.
