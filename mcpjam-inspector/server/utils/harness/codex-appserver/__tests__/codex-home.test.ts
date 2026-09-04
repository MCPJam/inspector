/**
 * The rendered `CODEX_HOME/config.toml`.
 *
 * Snapshotted as a whole because a config mistake here is otherwise invisible
 * until it surfaces as a puzzling failure inside a sandbox — a wrong key is a
 * `configWarning` Codex logs and carries on past.
 */
import { describe, expect, it } from "vitest";
import { renderCodexConfigToml } from "../bridge/codex-home.js";

const base = {
  codexHome: "/session/codex-home",
  baseUrl: "https://proxy.example/web/harness/model-proxy/openai/v1",
  apiKeyEnvVar: "CODEX_API_KEY",
};

describe("config.toml", () => {
  it("renders the provider block and the relay server", () => {
    expect(
      renderCodexConfigToml({
        ...base,
        hostToolsEntrypoint: "/bootstrap/host-tools-mcp.mjs",
        relayUrl: "http://127.0.0.1:41234",
        relayCredential: "s3cret",
        nodeExecutable: "/usr/bin/node",
        webSearch: true,
      }),
    ).toMatchInlineSnapshot(`
      "# Generated per session by MCPJam's codex app-server bridge. Do not edit:
      # it is rewritten on every session start.

      model_provider = "mcpjam"
      model_reasoning_summary = "detailed"
      web_search = "live"

      [model_providers.mcpjam]
      name = "MCPJam model proxy"
      base_url = "https://proxy.example/web/harness/model-proxy/openai/v1"
      env_key = "CODEX_API_KEY"
      wire_api = "responses"

      [mcp_servers.mcpjam]
      command = "/usr/bin/node"
      args = ["/bootstrap/host-tools-mcp.mjs"]
      startup_timeout_sec = 30
      tool_timeout_sec = 0

      [mcp_servers.mcpjam.env]
      MCPJAM_HOST_TOOL_RELAY_URL = "http://127.0.0.1:41234"
      MCPJAM_HOST_TOOL_RELAY_CREDENTIAL = "s3cret"
      "
    `);
  });

  it("omits the relay entirely when there are no host tools to serve", () => {
    const toml = renderCodexConfigToml(base);
    expect(toml).not.toContain("mcp_servers");
    expect(toml).toContain("[model_providers.mcpjam]");
  });

  it("keeps the host-tool timeout at zero", () => {
    // A host tool can be parked behind a human approval. ANY finite timeout
    // here would cancel exactly the approvals this transport exists to serve.
    const toml = renderCodexConfigToml({
      ...base,
      hostToolsEntrypoint: "/b/host-tools-mcp.mjs",
      relayUrl: "http://127.0.0.1:1",
      relayCredential: "c",
    });
    expect(toml).toContain("tool_timeout_sec = 0");
  });

  it("disables Codex's own web search unless the host asked for it", () => {
    expect(renderCodexConfigToml(base)).toContain('web_search = "disabled"');
    expect(renderCodexConfigToml({ ...base, webSearch: true })).toContain(
      'web_search = "live"',
    );
  });

  it("escapes a value that would otherwise break out of its TOML string", () => {
    // The base URL is deployment-configured. A quote or backslash in it must
    // not be able to terminate the string and inject config.
    const toml = renderCodexConfigToml({
      ...base,
      baseUrl: 'https://evil/"\nmodel = "pwned',
    });
    expect(toml).toContain('base_url = "https://evil/\\"\\nmodel = \\"pwned"');
    expect(toml).not.toContain('\nmodel = "pwned');
  });
});
