---
"@mcpjam/sdk": minor
---

`parsePluginBundle` takes a `profile` option. The default, `strict`, reads Agent Plugins 1.0 exactly as before. `openai-compatible` also reads the layouts OpenAI documents for Codex plugins: a `.codex-plugin/plugin.json` overlay beside a root `plugin.json` (which a root `extensions["com.openai"]` object replaces rather than merges with), or, when there is no root manifest, `.codex-plugin/`, `.agent-plugin/` or `.claude-plugin/plugin.json`. A root manifest stays authoritative and an invalid one is never rescued by a legacy manifest. Every result now carries `interpretation` (profile, layout, manifest path and any overlay), so callers can store how a bundle was read next to what it contains.
