---
"@mcpjam/inspector": patch
---

### `@mcpjam/inspector`
- **MCP Apps / widgets**: fix compat-mode output boot so apps render on first turn instead of waiting for a refresh (#2219); gate compat streaming so live-preferred widget fetches don't get short-circuited; prevent the blank MCP app reveal flicker on stream start; tighten streaming reveal + abort handling so cancelled tool calls don't leave half-rendered widgets.
- **App views**: unify app view saves on `mcpAppViews` and fix the `ui://` fallback path so views with synthesized URIs round-trip correctly (#2216); add `synthesize-fallback-uri` helper with coverage.
