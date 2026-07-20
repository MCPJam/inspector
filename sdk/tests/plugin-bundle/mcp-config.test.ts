/**
 * MCP configuration normalization — the three accepted source shapes, the
 * stdio/http discriminated union, secret-free requirements, and runtime
 * placeholder preservation.
 */

import { describe, expect, it } from "vitest";
import { parsePluginBundle } from "../../src/plugin-bundle/index.js";
import { expectParseError, minimalBundle } from "./fixtures.js";

const DIRECT_MAP = {
  "remote-server": {
    url: "https://mcp.example.com/mcp",
    headers: { Authorization: "${REMOTE_TOKEN}" },
  },
};

function withMcp(config: unknown) {
  return minimalBundle({ ".mcp.json": JSON.stringify(config) });
}

describe("MCP config shapes", () => {
  it.each([
    ["direct map", DIRECT_MAP],
    ["mcp_servers wrapper", { mcp_servers: DIRECT_MAP }],
    ["mcpServers wrapper", { mcpServers: DIRECT_MAP }],
  ])("normalizes the %s shape identically", async (_label, config) => {
    const parsed = await parsePluginBundle(withMcp(config));
    expect(parsed.mcpServers).toHaveLength(1);
    const server = parsed.mcpServers[0];
    expect(server.componentKey).toBe("server:remote-server");
    expect(server.key).toBe("remote-server");
    expect(server.sourcePath).toBe(".mcp.json");
    expect(server.config).toEqual({
      transport: "http",
      url: "https://mcp.example.com/mcp",
      headerRequirements: [{ name: "Authorization", secret: true }],
    });
  });

  it("produces the same configHash for all three shapes", async () => {
    const hashes = await Promise.all(
      [DIRECT_MAP, { mcp_servers: DIRECT_MAP }, { mcpServers: DIRECT_MAP }].map(
        async (config) => {
          const parsed = await parsePluginBundle(withMcp(config));
          return parsed.mcpServers[0].configHash;
        }
      )
    );
    expect(hashes[0]).toMatch(/^[0-9a-f]{64}$/);
    expect(hashes[1]).toBe(hashes[0]);
    expect(hashes[2]).toBe(hashes[0]);
  });

  it("rejects configs declaring both wrappers", async () => {
    await expectParseError(
      withMcp({ mcp_servers: DIRECT_MAP, mcpServers: DIRECT_MAP }),
      "MCP_DUPLICATE_WRAPPER"
    );
  });

  it("rejects a bare single-server object (not a server map)", async () => {
    await expectParseError(
      withMcp({ url: "https://mcp.example.com/mcp" }),
      "MCP_INVALID_CONFIG"
    );
  });
});

describe("stdio server normalization", () => {
  it("normalizes command/args/env and preserves ${PLUGIN_ROOT} verbatim", async () => {
    const parsed = await parsePluginBundle(
      withMcp({
        mcp_servers: {
          "local-server": {
            command: "node",
            args: ["${PLUGIN_ROOT}/server/index.js", "--verbose"],
            env: {
              API_KEY: "${API_KEY}",
              DATA_DIR: "${CODEX_PLUGIN_ROOT}/data",
              MODE: "production",
            },
          },
        },
      })
    );
    expect(parsed.mcpServers[0].config).toEqual({
      transport: "stdio",
      command: "node",
      // Runtime placeholders must never be substituted at parse time.
      args: ["${PLUGIN_ROOT}/server/index.js", "--verbose"],
      envRequirements: [
        { name: "API_KEY", required: true },
        {
          name: "DATA_DIR",
          required: false,
          valueTemplate: "${CODEX_PLUGIN_ROOT}/data",
        },
        // Literal value dropped — requirement name only.
        { name: "MODE", required: false },
      ],
    });
    expect(parsed.warnings).toEqual([
      expect.objectContaining({
        code: "MCP_ENV_VALUE_OMITTED",
        componentKey: "server:local-server",
      }),
    ]);
    // Literal env value never appears anywhere in the parsed output.
    expect(JSON.stringify(parsed)).not.toContain("production");
  });

  it("requires a command", async () => {
    await expectParseError(
      withMcp({ mcp_servers: { bad: { type: "stdio" } } }),
      "MCP_MISSING_COMMAND"
    );
  });

  it("rejects absolute working directories without a root placeholder", async () => {
    await expectParseError(
      withMcp({
        mcp_servers: {
          bad: { command: "node", cwd: "/Users/someone/plugin" },
        },
      }),
      "MCP_ABSOLUTE_WORKING_DIRECTORY"
    );
  });

  it("accepts ${PLUGIN_ROOT} working directories", async () => {
    const parsed = await parsePluginBundle(
      withMcp({
        mcp_servers: {
          ok: { command: "node", cwd: "${PLUGIN_ROOT}/server" },
        },
      })
    );
    const config = parsed.mcpServers[0].config;
    expect(config.transport).toBe("stdio");
    if (config.transport === "stdio") {
      expect(config.workingDirectory).toBe("${PLUGIN_ROOT}/server");
    }
  });
});

describe("http server normalization", () => {
  it("requires HTTPS for remote URLs", async () => {
    await expectParseError(
      withMcp({ mcp_servers: { bad: { url: "http://mcp.example.com" } } }),
      "MCP_INSECURE_URL"
    );
  });

  it("allows plain-HTTP loopback with a warning", async () => {
    const parsed = await parsePluginBundle(
      withMcp({ mcp_servers: { dev: { url: "http://localhost:3100/mcp" } } })
    );
    expect(parsed.mcpServers).toHaveLength(1);
    expect(parsed.warnings).toEqual([
      expect.objectContaining({ code: "MCP_INSECURE_URL_LOCALHOST" }),
    ]);
  });

  it("captures oauth hints and authentication timing", async () => {
    const parsed = await parsePluginBundle(
      withMcp({
        mcp_servers: {
          crm: {
            url: "https://crm.example.com/mcp",
            authentication: "ON_INSTALL",
            oauth: {
              scopes: ["read", "write"],
              authorization_server: "https://auth.example.com",
              client_secret: "shhh-never-store",
            },
          },
        },
      })
    );
    const config = parsed.mcpServers[0].config;
    expect(config.transport).toBe("http");
    if (config.transport === "http") {
      expect(config.oauth).toEqual({
        timing: "on_install",
        scopes: ["read", "write"],
        metadata: { authorization_server: "https://auth.example.com" },
      });
    }
    // Secret-bearing oauth fields are dropped with a warning.
    expect(JSON.stringify(parsed)).not.toContain("shhh-never-store");
    expect(parsed.warnings).toEqual([
      expect.objectContaining({ code: "MCP_SECRET_FIELD_OMITTED" }),
    ]);
    expect(parsed.setupRequirements).toEqual([
      {
        kind: "oauth",
        componentKey: "server:crm",
        serverKey: "crm",
        timing: "on_install",
      },
    ]);
  });

  it("marks secret-looking headers and omits literal header values", async () => {
    const parsed = await parsePluginBundle(
      withMcp({
        mcp_servers: {
          api: {
            url: "https://api.example.com/mcp",
            headers: {
              "X-Api-Key": "literal-key-value",
              Accept: "application/json",
            },
          },
        },
      })
    );
    const config = parsed.mcpServers[0].config;
    if (config.transport === "http") {
      // Sorted by name so configHash is insensitive to source key order.
      expect(config.headerRequirements).toEqual([
        { name: "Accept", secret: false },
        { name: "X-Api-Key", secret: true },
      ]);
    }
    expect(JSON.stringify(parsed)).not.toContain("literal-key-value");
  });
});

describe("MCP transport and limit errors", () => {
  it("rejects unknown transports", async () => {
    await expectParseError(
      withMcp({
        mcp_servers: { bad: { type: "websocket", url: "https://x.example" } },
      }),
      "MCP_UNKNOWN_TRANSPORT"
    );
  });

  it("rejects ambiguous command+url configs", async () => {
    await expectParseError(
      withMcp({
        mcp_servers: {
          bad: { command: "node", url: "https://mcp.example.com" },
        },
      }),
      "MCP_AMBIGUOUS_TRANSPORT"
    );
  });

  it("rejects invalid server names", async () => {
    await expectParseError(
      withMcp({ mcp_servers: { "bad name!": { command: "node" } } }),
      "MCP_INVALID_SERVER_NAME"
    );
  });

  it("enforces the max MCP server count", async () => {
    const servers: Record<string, unknown> = {};
    for (let i = 0; i < 3; i++) {
      servers[`server-${i}`] = { url: `https://s${i}.example.com/mcp` };
    }
    await expectParseError(
      withMcp({ mcp_servers: servers }),
      "MCP_TOO_MANY_SERVERS",
      { limits: { maxMcpServers: 2 } }
    );
  });
});

describe("secret hygiene regressions (review fixes)", () => {
  it("drops secret-looking VALUES under aliased unknown keys", async () => {
    const parsed = await parsePluginBundle(
      withMcp({
        mcp_servers: {
          api: {
            url: "https://api.example.com/mcp",
            // Key "auth" is not on the name denylist — the VALUE screen
            // must catch it anyway.
            auth: "Bearer sk-live-12345abc",
          },
        },
      })
    );
    expect(parsed.mcpServers[0].extensions).toEqual({});
    expect(JSON.stringify(parsed)).not.toContain("sk-live-12345abc");
    expect(
      parsed.warnings.some((issue) => issue.code === "MCP_SECRET_FIELD_OMITTED")
    ).toBe(true);
  });

  it("drops nested secret keys inside unknown extension objects", async () => {
    const parsed = await parsePluginBundle(
      withMcp({
        mcp_servers: {
          api: {
            url: "https://api.example.com/mcp",
            config: { password: "hunter2", theme: "dark" },
          },
        },
      })
    );
    expect(parsed.mcpServers[0].extensions).toEqual({
      config: { theme: "dark" },
    });
    expect(JSON.stringify(parsed)).not.toContain("hunter2");
    expect(
      parsed.warnings.some((issue) => issue.code === "MCP_SECRET_FIELD_OMITTED")
    ).toBe(true);
  });

  it("drops nested secrets inside oauth metadata (hashed config)", async () => {
    const parsed = await parsePluginBundle(
      withMcp({
        mcp_servers: {
          crm: {
            url: "https://crm.example.com/mcp",
            oauth: {
              authorization_server: "https://auth.example.com",
              extra: { api_key: "sk_live_deep_secret" },
            },
          },
        },
      })
    );
    const config = parsed.mcpServers[0].config;
    expect(config.transport).toBe("http");
    if (config.transport === "http") {
      expect(config.oauth?.metadata).toEqual({
        authorization_server: "https://auth.example.com",
        extra: {},
      });
    }
    expect(JSON.stringify(parsed)).not.toContain("sk_live_deep_secret");
  });

  it("does not store a secret with a ${PLUGIN_ROOT} placeholder smuggled in", async () => {
    const parsed = await parsePluginBundle(
      withMcp({
        mcp_servers: {
          local: {
            command: "node",
            env: { API_KEY: "sk-live-abc${PLUGIN_ROOT}" },
          },
        },
      })
    );
    expect(parsed.mcpServers[0].config).toEqual({
      transport: "stdio",
      command: "node",
      args: [],
      // Dropped literal: name only, no valueTemplate.
      envRequirements: [{ name: "API_KEY", required: false }],
    });
    expect(JSON.stringify(parsed)).not.toContain("sk-live-abc");
    expect(
      parsed.warnings.some((issue) => issue.code === "MCP_ENV_VALUE_OMITTED")
    ).toBe(true);
  });

  it("registers composite env references as required setup", async () => {
    const parsed = await parsePluginBundle(
      withMcp({
        mcp_servers: {
          db: {
            command: "node",
            env: { CONN: "postgres://${DB_HOST}:${DB_PORT}/x" },
          },
        },
      })
    );
    const config = parsed.mcpServers[0].config;
    expect(config.transport).toBe("stdio");
    if (config.transport === "stdio") {
      expect(config.envRequirements).toEqual([
        {
          name: "CONN",
          required: false,
          valueTemplate: "postgres://${DB_HOST}:${DB_PORT}/x",
        },
        { name: "DB_HOST", required: true },
        { name: "DB_PORT", required: true },
      ]);
    }
    expect(parsed.setupRequirements).toEqual([
      {
        kind: "env",
        componentKey: "server:db",
        serverKey: "db",
        name: "DB_HOST",
        required: true,
      },
      {
        kind: "env",
        componentKey: "server:db",
        serverKey: "db",
        name: "DB_PORT",
        required: true,
      },
    ]);
  });

  it("drops composite templates whose remainder looks like a credential", async () => {
    const parsed = await parsePluginBundle(
      withMcp({
        mcp_servers: {
          db: {
            command: "node",
            env: { CONN: "sk-live-aaaabbbbccccdddd${DB_HOST}" },
          },
        },
      })
    );
    const config = parsed.mcpServers[0].config;
    if (config.transport === "stdio") {
      expect(config.envRequirements).toEqual([
        { name: "CONN", required: false },
      ]);
    }
    expect(JSON.stringify(parsed)).not.toContain("sk-live-aaaabbbbccccdddd");
  });
});

describe("direct-map discrimination and hash stability (review fixes)", () => {
  it("accepts a direct map containing a server legitimately named 'url'", async () => {
    const parsed = await parsePluginBundle(
      withMcp({
        url: { url: "https://one.example.com/mcp" },
        other: { url: "https://two.example.com/mcp" },
      })
    );
    expect(parsed.mcpServers.map((server) => server.key).sort()).toEqual([
      "other",
      "url",
    ]);
  });

  it("accepts a direct map containing a server named 'command'", async () => {
    const parsed = await parsePluginBundle(
      withMcp({ command: { command: "node" } })
    );
    expect(parsed.mcpServers.map((server) => server.key)).toEqual(["command"]);
  });

  it("produces the same configHash regardless of env key source order", async () => {
    const forward = await parsePluginBundle(
      withMcp({
        mcp_servers: {
          s: {
            command: "node",
            env: { A_VAR: "${A_VAR}", B_VAR: "${B_VAR}" },
          },
        },
      })
    );
    const reversed = await parsePluginBundle(
      withMcp({
        mcp_servers: {
          s: {
            command: "node",
            env: { B_VAR: "${B_VAR}", A_VAR: "${A_VAR}" },
          },
        },
      })
    );
    expect(reversed.mcpServers[0].configHash).toBe(
      forward.mcpServers[0].configHash
    );
  });

  it("produces the same configHash regardless of header key source order", async () => {
    const forward = await parsePluginBundle(
      withMcp({
        s: {
          url: "https://api.example.com/mcp",
          headers: { Accept: "${ACCEPT}", "X-Api-Key": "${X_API_KEY}" },
        },
      })
    );
    const reversed = await parsePluginBundle(
      withMcp({
        s: {
          url: "https://api.example.com/mcp",
          headers: { "X-Api-Key": "${X_API_KEY}", Accept: "${ACCEPT}" },
        },
      })
    );
    expect(reversed.mcpServers[0].configHash).toBe(
      forward.mcpServers[0].configHash
    );
  });
});
