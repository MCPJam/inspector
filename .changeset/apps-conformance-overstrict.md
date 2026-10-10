---
"@mcpjam/sdk": patch
"@mcpjam/inspector": patch
---

Stop failing MCP Apps servers for two things the spec does not require.

`ui-listed-resources-valid` failed any `resources/list` entry whose `mimeType`
was not `text/html;profile=mcp-app`. In `apps.mdx` that value is a **SHOULD** on
the listing (`UIResource.mimeType`: "SHOULD be `text/html;profile=mcp-app` for
HTML-based UIs in the initial MVP"). It is a **MUST** on the read result, under
Content Requirements — and `ui-resource-contents-valid` already enforces it
there. So the listing rule now warns instead of failing, and says why. The
`ui://` scheme on the same entry is a genuine MUST and still fails.

`ui-resource-contents-valid` required `resources/read` to return exactly one
content entry. No such rule exists: the Content Requirements are stated per
content item and never cap the array, and the single-element `contents: [{…}]`
in the spec is an example. A server returning two valid HTML payloads was
reported as defective. The check now requires at least one entry — an empty
array is still a violation, since there is nothing to render — and grades every
entry that comes back against all four Content Requirements.

The second change is the riskier one, because "not exactly one" was also what
stopped the loop: a regression test now proves a bad second entry is still
caught rather than silently skipped once multiple entries are allowed.

Neither check gained or lost an id, so the pool is still seven and scores move
only for servers that were being failed for these two reasons.
