---
"@mcpjam/cli": minor
"@mcpjam/sdk": patch
---

Add `mcpjam subscriptions listen` — a terminal mode for the MCP 2026-07-28
`subscriptions/listen` stream, driving the SDK's `SubscriptionCoordinator`.
Interests are selected with `--tools-list-changed` / `--prompts-list-changed` /
`--resources-list-changed` / `--list-changed` / `--resource-uri`, the
acknowledgement is printed as its own `subscription.acknowledged` event
(distinct from notifications, which are each tagged with their local and MCP
subscription ids), and Ctrl-C cancels the subscription locally and exits 0.
Close reasons are distinct outcomes: `graceful` and `cancelled` exit 0, while a
remote loss exits 1 with `SUBSCRIPTION_REMOTE_CLOSED`. `--relisten <count>`
opts into a bounded re-listen with exponential backoff. stdout carries only
NDJSON events (no human progress text, in either `--format`); human status goes
to stderr. The SDK re-exports the subscription coordinator surface from the
package root so the CLI can drive it without a subpath import.
