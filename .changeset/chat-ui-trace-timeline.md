---
"@mcpjam/chat-ui": minor
---

Add the recorded-trace waterfall as a new `@mcpjam/chat-ui/trace-timeline` subpath.

`TraceTimeline` renders the per-step trace waterfall (per-span latency + token
counts, hover for wall-clock start/end) from a `TraceSpan[]`. Tier-A clean:
provider-free, no posthog / design-system / convex / widget-runtime imports —
it reuses the package's own `JsonView` / `Markdown` / `tool-result-text` / `cn`
plus small local UI shims, and the `trace-waterfall-*` classes + their tokens
ship in `styles.css` scoped under `.mcpjam-chat-ui`. New subpath only; existing
exports are unchanged.
