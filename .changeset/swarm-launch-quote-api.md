---
"@mcpjam/inspector": patch
"@mcpjam/sdk": patch
"@mcpjam/cli": patch
---

Swarm launches can be priced before they run, and a refused launch says what would fit.

- **Quote route.** `POST /api/v1/projects/{projectId}/swarms/quote` takes the concrete runs a launch would start (a goal with optional `environmentIds`, `iterations`, `maxTurns` and `setupWrites` overrides, or bare environments with `maxTurns`). It returns how many sessions are free starter conversations, what the rest would cost in credits, whether the organization's credits fit it (`fits`), and how many sessions do (`maxAffordableSessions`). It reads only and reserves nothing, so the launch still admits each run itself.
- **SDK.** `PlatformApiClient.quoteSwarmLaunch` and the `quote_swarm_launch` operation, which the MCP server and the agent API also expose. `describePlatformRefusal` now also describes a launch the organization's credits cannot fund, allowlisting `creditsRequired`, `creditsAvailable`, `maxAffordableSessions` and `resetsAt`, and `platformRefusalHint` says how far short it is and how many sessions fit.
- **CLI.** `mcpjam cloud swarms quote` prices one run per `--goal` (with `--environment`, `--iterations` and `--max-turns` as shared overrides), bare `--environment`s with `--max-turns`, or a `--plan` JSON array. A refused launch prints the same hint and carries the numbers in `details.refusal`.
- **Launch errors.** A launch refused for credits already carried its numbers in `details`; that is now covered by a test. A launch whose admission was too busy to decide now answers a retryable `RATE_LIMITED` with the backend's `Retry-After` (a 503 on the hosted app) instead of an internal error. Nothing was created, and the same launch key can be retried.
