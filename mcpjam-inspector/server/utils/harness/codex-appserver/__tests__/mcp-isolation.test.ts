import { describe, expect, it } from "vitest";
import {
  foreignMcpServerOverrides,
  mcpServerNamesInToml,
} from "../bridge/mcp-isolation.js";

describe("MCP isolation from codex's system and managed layers", () => {
  it("finds every spelling of a server name under mcp_servers", () => {
    const toml = `
model = "x"
[mcp_servers.plain]
command = "a"
[mcp_servers.plain.env]
K = "v"
[mcp_servers."quoted.name"]
command = "b"
[mcp_servers.'literal']
command = "c"
mcp_servers.dotted.command = "d"
[mcp_servers]
inline = { command = "e" }
another.command = "f"
[other]
notaserver = { command = "g" }
`;
    expect(mcpServerNamesInToml(toml)).toEqual(
      ["another", "dotted", "inline", "literal", "plain", "quoted.name"].sort(),
    );
  });

  it("disables every foreign server and never the relay", () => {
    const files: Record<string, string> = {
      "/etc/codex/config.toml": "[mcp_servers.etc_system]\ncommand = 'x'\n[mcp_servers.mcpjam]\ncommand='y'\n",
      "/etc/codex/managed_config.toml": "[mcp_servers.etc_managed]\ncommand = 'z'\n",
    };
    expect(
      foreignMcpServerOverrides({
        keep: "mcpjam",
        readFile: (path) => files[path] ?? null,
        platform: "linux",
      }),
    ).toEqual({
      etc_system: { enabled: false },
      etc_managed: { enabled: false },
    });
  });

  it("is a no-op where no system layer exists", () => {
    expect(
      foreignMcpServerOverrides({
        keep: "mcpjam",
        readFile: () => null,
        platform: "darwin",
      }),
    ).toEqual({});
  });
});
