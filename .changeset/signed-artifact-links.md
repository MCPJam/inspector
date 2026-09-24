---
"@mcpjam/widget-react": patch
"@mcpjam/inspector": patch
---

Private chat artifacts (transcripts, trace spans, captured widget HTML, tool output, screenshots and reports) are now read through short-lived signed links instead of permanent storage links. When a page outlives a link, the inspector re-runs the query that authorized it and retries with the new link, and a re-minted link to the same widget no longer reloads a cached replay. `@mcpjam/widget-react` gains two optional host services for hosts whose artifact links expire: `fetchArtifact`, used to read cached widget HTML, and `artifactCacheKey`, which names the object a link points at.
