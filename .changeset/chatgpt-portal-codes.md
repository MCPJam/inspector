---
"@mcpjam/sdk": minor
---

The ChatGPT readiness engine carries the plugin portal's 269 submission error codes as data (`OPENAI_PORTAL_CODES`), each with the portal's message, severity, stage, and the field or file it names. `validateOpenAIPortalDocument` checks a plugin manifest, a skill's front matter or `agents/openai.yaml`, `.mcp.json` or `.app.json` against the codes' presence, type, length, pattern, value and count rules. Each portal issue now has a `portalCode` when the portal lists one for its rule, and findings from checks that grade a single portal rule have `details.portalCode`, so a result can be matched to the portal's own message.
