---
"@mcpjam/sdk": minor
---

The plugin parser's `openai-compatible` profile accepts what the ChatGPT portal accepts: a plugin zipped inside one top-level folder, and a name with uppercase letters or `_`. A ZIP with files beside that folder, or with two folders that each hold a manifest, is refused with the portal's code and message. The ChatGPT readiness reader now finds the plugin the same way, so a package with a root `plugin.json` no longer grades as having no manifest. It reports the portal's codes for a missing manifest and for `name`, including the portal's 64-character limit.
