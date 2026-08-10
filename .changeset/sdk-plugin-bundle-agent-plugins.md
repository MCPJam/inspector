---
"@mcpjam/sdk": major
---

`@mcpjam/sdk/plugin-bundle` now implements **Agent Plugins 1.0** (agent-plugins.org) instead of the OpenAI Codex bundle format. **This is a replacement, not a dispatch — Codex-format bundles no longer parse.** The plugins feature is flag-gated and pre-GA, so carrying two formats forward would have preserved an ambiguity nobody is using yet.

- **Manifest is root `plugin.json`.** `$schema` is required and matched against compiled-in schemas (never fetched — a spec MUST) to resolve the version. Names follow the AP rule: dots legal (`com.example.plugin`), no `--` or `..`, 1–64 chars; `version` is free-form rather than semver. The object is closed — unknown top-level fields are reported and ignored, while execution-ambiguous ones (`scripts`, `install`, …) are still rejected. Client metadata moves into the reverse-domain `extensions` map; MCPJam reads `displayName`/`icon`/`logo` from `com.mcpjam` and preserves other namespaces untouched.
- **MCP config is root `mcp.json`,** requiring `$schema` + `mcpServers`, with an Agent Plugins version that must match `plugin.json`. Per-entry `type` (`stdio` | `streamable-http` | `sse`) is authoritative: no command/url inference and no spelling folds on the plugin path, and HTTP entries record `httpVariant` so a declared `sse` is honored. Reserved env keys (`PLUGIN_ROOT`, `PLUGIN_DATA`) are rejected, placeholders are barred from `command`, and `cwd` must be `./`- or placeholder-rooted with containment checks.
- **Failures isolate.** One bad skill or server entry is skipped and reported on the new `ParsedPluginBundle.skipped` with its issues demoted to warnings; an invalid `mcp.json` disables only the MCP component type. Only manifest, archive and limit violations reject the whole bundle.
- **Non-secret literals survive.** `MODE=production` or `X-Api-Version: 2` are stored so a portable plugin runs with no setup step; secret-looking names and values still collapse to name-only setup requirements.
- **Removed:** the `.codex-plugin/` manifest directory, `.mcp.json`, the `CODEX_PLUGIN_ROOT` alias, `agents/openai.yaml` skill metadata, and semver-required versions.

The lenient shape primitives (`selectPluginMcpServerMap`, `detectPluginMcpTransport`) are unchanged — the generic MCP-JSON import path depends on their tolerance, and only the plugin path got strict.
