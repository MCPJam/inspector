---
"@mcpjam/sdk": minor
---

The ChatGPT readiness engine carries the plugin portal's 269 submission error codes as data (`OPENAI_PORTAL_CODES`), each with the portal's message, severity, stage, and the field or file it names. `validateOpenAIPortalDocument` checks a plugin manifest, a skill's front matter or `agents/openai.yaml`, `.mcp.json` or `.app.json` against the codes' presence, type, length, pattern, value and count rules.
