---
"@mcpjam/chat-ui": minor
---

Introduce `@mcpjam/chat-ui` — a reusable, read-only transcript renderer (Tier
A) for AI SDK `UIMessage`s. Renders text, reasoning, files, sources, JSON/data
parts, approvals-as-state, and tool call/result blocks. Widget-bearing tool
calls render a deterministic placeholder; the package is provider-free (no
Convex/PostHog/inspector/widget-runtime imports, enforced by a build-time
guard). Hosts can inject interactive tool/widget rendering via the
`renderTool`/`renderWidget` seams on `Transcript`.
