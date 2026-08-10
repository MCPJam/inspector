/**
 * MCP configuration normalization — Agent Plugins 1.0 strict document rules
 * (`$schema` + `mcpServers`, closed), authoritative per-entry transports,
 * failure isolation (entry problems skip the entry, document problems
 * disable the component type), secret-screened literal values, and runtime
 * placeholder preservation.
 */

import { describe, expect, it } from "vitest";
import { parsePluginBundle } from "../../src/plugin-bundle/index.js";
import {
  MCP_SCHEMA_URL,
  expectParseError,
  mcpJson,
  minimalBundle,
} from "./fixtures.js";

function withMcp(servers: Record<string, unknown>) {
  return minimalBundle({ "mcp.json": mcpJson(servers) });
}

function withMcpDocument(document: unknown) {
  return minimalBundle({ "mcp.json": JSON.stringify(document) });
}

describe("MCP document rules", () => {
  it("normalizes a valid document", async () => {
    const parsed = await parsePluginBundle(
      withMcp({
        "remote-server": {
          type: "streamable-http",
          url: "https://mcp.example.com/mcp",
          headers: { Authorization: "${REMOTE_TOKEN}" },
        },
      })
    );
    expect(parsed.mcpServers).toHaveLength(1);
    const server = parsed.mcpServers[0];
    expect(server.componentKey).toBe("server:remote-server");
    expect(server.key).toBe("remote-server");
    expect(server.sourcePath).toBe("mcp.json");
    expect(server.config).toEqual({
      transport: "http",
      httpVariant: "streamable-http",
      url: "https://mcp.example.com/mcp",
      headerRequirements: [{ name: "Authorization", secret: true }],
    });
    expect(server.configHash).toMatch(/^[0-9a-f]{64}$/);
    expect(parsed.skipped).toEqual([]);
  });

  it.each([
    ["missing $schema", { mcpServers: {} }],
    [
      "unsupported $schema",
      {
        $schema: "https://agent-plugins.org/schemas/9.9.9/mcp.schema.json",
        mcpServers: {},
      },
    ],
    [
      "Codex mcp_servers wrapper (unknown field)",
      { $schema: MCP_SCHEMA_URL, mcp_servers: {} },
    ],
    ["missing mcpServers", { $schema: MCP_SCHEMA_URL }],
    ["non-object document", ["not", "a", "map"]],
  ])(
    "disables the MCP component type (never the bundle) on %s",
    async (_label, document) => {
      const parsed = await parsePluginBundle(withMcpDocument(document));
      expect(parsed.mcpServers).toEqual([]);
      expect(parsed.skipped).toEqual([
        expect.objectContaining({ kind: "mcp-config", key: "mcp.json" }),
      ]);
      expect(
        parsed.warnings.some((issue) => issue.code === "COMPONENT_SKIPPED")
      ).toBe(true);
    }
  );

  it("disables the MCP component type on invalid JSON", async () => {
    const parsed = await parsePluginBundle(
      minimalBundle({ "mcp.json": "{ not json" })
    );
    expect(parsed.mcpServers).toEqual([]);
    expect(parsed.skipped).toEqual([
      expect.objectContaining({ kind: "mcp-config" }),
    ]);
  });

  it("ignores nested mcp.json files with a warning", async () => {
    const parsed = await parsePluginBundle(
      minimalBundle({ "vendored/mcp.json": mcpJson({}) })
    );
    expect(parsed.mcpServers).toEqual([]);
    expect(
      parsed.warnings.some((issue) => issue.code === "MCP_CONFIG_IGNORED")
    ).toBe(true);
  });
});

describe("entry-level failure isolation", () => {
  it("skips one invalid entry without disabling valid siblings", async () => {
    const parsed = await parsePluginBundle(
      withMcp({
        good: { type: "streamable-http", url: "https://ok.example.com/mcp" },
        "no-type": { url: "https://missing-type.example.com/mcp" },
        "bad-transport": { type: "websocket", url: "https://ws.example.com" },
        "folded-spelling": {
          type: "streamable_http",
          url: "https://folded.example.com/mcp",
        },
        "unknown-field": {
          type: "streamable-http",
          url: "https://extra.example.com/mcp",
          auth: "Bearer sk-live-12345abc",
        },
        "bad name!": { type: "stdio", command: "node" },
      })
    );
    expect(parsed.mcpServers.map((server) => server.key)).toEqual(["good"]);
    expect(parsed.skipped.map((skip) => skip.key).sort()).toEqual([
      "bad name!",
      "bad-transport",
      "folded-spelling",
      "no-type",
      "unknown-field",
    ]);
    // Skipped-entry problems survive as warnings, never errors.
    expect(
      parsed.warnings.filter((issue) => issue.code === "COMPONENT_SKIPPED")
    ).toHaveLength(5);
    // The unknown field's secret-looking value never lands anywhere.
    expect(JSON.stringify(parsed)).not.toContain("sk-live-12345abc");
  });

  it("skips an ambiguous or insecure entry, keeping the rest", async () => {
    const parsed = await parsePluginBundle(
      withMcp({
        insecure: { type: "streamable-http", url: "http://mcp.example.com" },
        ok: { type: "stdio", command: "node" },
      })
    );
    expect(parsed.mcpServers.map((server) => server.key)).toEqual(["ok"]);
    expect(parsed.skipped).toEqual([
      expect.objectContaining({ kind: "server", key: "insecure" }),
    ]);
  });
});

describe("stdio server normalization", () => {
  it("normalizes command/args/env, preserves placeholders, stores screened literals", async () => {
    const parsed = await parsePluginBundle(
      withMcp({
        "local-server": {
          type: "stdio",
          command: "node",
          args: ["${PLUGIN_ROOT}/server/index.js", "--verbose"],
          env: {
            API_KEY: "${API_KEY}",
            DATA_DIR: "${PLUGIN_DATA}/data",
            MODE: "production",
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
          valueTemplate: "${PLUGIN_DATA}/data",
        },
        // Screened non-secret literal: stored, so no setup step is needed.
        { name: "MODE", required: false, value: "production" },
      ],
    });
    expect(parsed.warnings).toEqual([]);
    expect(parsed.setupRequirements).toEqual([
      {
        kind: "env",
        componentKey: "server:local-server",
        serverKey: "local-server",
        name: "API_KEY",
        required: true,
      },
    ]);
  });

  it("drops secret-looking literal env values with a warning", async () => {
    const parsed = await parsePluginBundle(
      withMcp({
        local: {
          type: "stdio",
          command: "node",
          env: { SERVICE_TOKEN: "sk-live-abcdef123456" },
        },
      })
    );
    const config = parsed.mcpServers[0].config;
    if (config.transport === "stdio") {
      // The bundle declared a value we refused to store: the component
      // cannot run until the user re-supplies it, so it is REQUIRED setup.
      expect(config.envRequirements).toEqual([
        { name: "SERVICE_TOKEN", required: true },
      ]);
    }
    expect(JSON.stringify(parsed)).not.toContain("sk-live-abcdef123456");
    expect(
      parsed.warnings.some((issue) => issue.code === "MCP_ENV_VALUE_OMITTED")
    ).toBe(true);
    // A dropped literal becomes a required setup requirement.
    expect(parsed.setupRequirements).toEqual([
      expect.objectContaining({
        kind: "env",
        name: "SERVICE_TOKEN",
        required: true,
      }),
    ]);
  });

  it("drops literals embedding URL basic-auth credentials", async () => {
    const parsed = await parsePluginBundle(
      withMcp({
        db: {
          type: "stdio",
          command: "node",
          env: { DATABASE_URL: "postgres://svc:hunter2@db.internal:5432/app" },
        },
      })
    );
    const config = parsed.mcpServers[0].config;
    if (config.transport === "stdio") {
      expect(config.envRequirements).toEqual([
        { name: "DATABASE_URL", required: true },
      ]);
    }
    expect(JSON.stringify(parsed)).not.toContain("hunter2");
  });

  it("canonicalizes ./ commands to the ${PLUGIN_ROOT} form", async () => {
    const parsed = await parsePluginBundle(
      withMcp({ local: { type: "stdio", command: "./bin/server" } })
    );
    const config = parsed.mcpServers[0].config;
    expect(config.transport).toBe("stdio");
    if (config.transport === "stdio") {
      // The placeholder form is what routes the component through
      // materialization — a bare relative command would spawn against the
      // host process directory.
      expect(config.command).toBe("${PLUGIN_ROOT}/bin/server");
    }
  });

  it("skips entries whose env defines the reserved placeholder keys", async () => {
    const parsed = await parsePluginBundle(
      withMcp({
        bad: {
          type: "stdio",
          command: "node",
          env: { PLUGIN_ROOT: "/tmp/evil" },
        },
      })
    );
    expect(parsed.mcpServers).toEqual([]);
    expect(parsed.skipped).toEqual([
      expect.objectContaining({ kind: "server", key: "bad" }),
    ]);
    expect(
      parsed.warnings.some((issue) => issue.code === "MCP_RESERVED_ENV_KEY")
    ).toBe(true);
  });

  it("skips entries with a placeholder in command (expansion is args/env/cwd only)", async () => {
    const parsed = await parsePluginBundle(
      withMcp({
        bad: { type: "stdio", command: "${PLUGIN_ROOT}/bin/server" },
        ok: { type: "stdio", command: "./bin/server" },
      })
    );
    expect(parsed.mcpServers.map((server) => server.key)).toEqual(["ok"]);
    expect(
      parsed.warnings.some(
        (issue) => issue.code === "MCP_PLACEHOLDER_IN_COMMAND"
      )
    ).toBe(true);
  });

  it("skips entries whose ./ command escapes the plugin root", async () => {
    const parsed = await parsePluginBundle(
      withMcp({
        bad: { type: "stdio", command: "./bin/../../outside" },
      })
    );
    expect(parsed.mcpServers).toEqual([]);
    expect(
      parsed.warnings.some((issue) => issue.code === "PATH_ESCAPES_ROOT")
    ).toBe(true);
  });

  it("requires a command", async () => {
    const parsed = await parsePluginBundle(
      withMcp({ bad: { type: "stdio" } })
    );
    expect(parsed.skipped).toEqual([
      expect.objectContaining({ key: "bad", kind: "server" }),
    ]);
    expect(
      parsed.warnings.some((issue) => issue.code === "MCP_MISSING_COMMAND")
    ).toBe(true);
  });

  it.each([
    // `./` cwds canonicalize to the placeholder form, same as commands.
    ["./server", "${PLUGIN_ROOT}/server"],
    ["./", "${PLUGIN_ROOT}"],
    ["${PLUGIN_ROOT}/server", "${PLUGIN_ROOT}/server"],
    ["${PLUGIN_DATA}", "${PLUGIN_DATA}"],
    ["${PLUGIN_DATA}/cache", "${PLUGIN_DATA}/cache"],
  ])("accepts spec-conforming cwd %j as %j", async (cwd, expected) => {
    const parsed = await parsePluginBundle(
      withMcp({ ok: { type: "stdio", command: "node", cwd } })
    );
    const config = parsed.mcpServers[0].config;
    expect(config.transport).toBe("stdio");
    if (config.transport === "stdio") {
      expect(config.workingDirectory).toBe(expected);
    }
  });

  it("skips entries whose ./ cwd escapes the plugin root", async () => {
    const parsed = await parsePluginBundle(
      withMcp({ bad: { type: "stdio", command: "node", cwd: "./a/../../out" } })
    );
    expect(parsed.mcpServers).toEqual([]);
    expect(
      parsed.warnings.some((issue) => issue.code === "PATH_ESCAPES_ROOT")
    ).toBe(true);
  });

  it.each(["/Users/someone/plugin", "relative/path", "..", "${OTHER_VAR}/x"])(
    "skips entries with non-conforming cwd %j",
    async (cwd) => {
      const parsed = await parsePluginBundle(
        withMcp({ bad: { type: "stdio", command: "node", cwd } })
      );
      expect(parsed.mcpServers).toEqual([]);
      expect(
        parsed.warnings.some(
          (issue) => issue.code === "MCP_INVALID_WORKING_DIRECTORY"
        )
      ).toBe(true);
    }
  );
});

describe("http server normalization", () => {
  it("records the declared transport as httpVariant (authoritative, not folded)", async () => {
    const parsed = await parsePluginBundle(
      withMcp({
        modern: { type: "streamable-http", url: "https://a.example.com/mcp" },
        legacy: { type: "sse", url: "https://b.example.com/sse" },
      })
    );
    const byKey = new Map(
      parsed.mcpServers.map((server) => [server.key, server.config])
    );
    expect(byKey.get("modern")).toMatchObject({
      transport: "http",
      httpVariant: "streamable-http",
    });
    expect(byKey.get("legacy")).toMatchObject({
      transport: "http",
      httpVariant: "sse",
    });
  });

  it("allows plain-HTTP loopback with a warning", async () => {
    const parsed = await parsePluginBundle(
      withMcp({
        dev: { type: "streamable-http", url: "http://localhost:3100/mcp" },
      })
    );
    expect(parsed.mcpServers).toHaveLength(1);
    expect(parsed.warnings).toEqual([
      expect.objectContaining({ code: "MCP_INSECURE_URL_LOCALHOST" }),
    ]);
  });

  it("stores screened non-secret literal headers; secret-named stay name-only", async () => {
    const parsed = await parsePluginBundle(
      withMcp({
        api: {
          type: "streamable-http",
          url: "https://api.example.com/mcp",
          headers: {
            "X-Api-Key": "literal-key-value",
            Accept: "application/json",
          },
        },
      })
    );
    const config = parsed.mcpServers[0].config;
    if (config.transport === "http") {
      // Sorted by name so configHash is insensitive to source key order.
      expect(config.headerRequirements).toEqual([
        { name: "Accept", secret: false, value: "application/json" },
        { name: "X-Api-Key", secret: true },
      ]);
    }
    expect(JSON.stringify(parsed)).not.toContain("literal-key-value");
    // The stored literal needs no setup; the secret-named header does.
    expect(parsed.setupRequirements).toEqual([
      expect.objectContaining({
        kind: "header",
        name: "X-Api-Key",
        secret: true,
      }),
    ]);
  });

  it("captures oauth hints and authentication timing (MCPJam extension fields)", async () => {
    const parsed = await parsePluginBundle(
      withMcp({
        crm: {
          type: "streamable-http",
          url: "https://crm.example.com/mcp",
          authentication: "ON_INSTALL",
          oauth: {
            scopes: ["read", "write"],
            authorization_server: "https://auth.example.com",
            client_secret: "shhh-never-store",
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
    expect(
      parsed.warnings.some((issue) => issue.code === "MCP_SECRET_FIELD_OMITTED")
    ).toBe(true);
    expect(parsed.setupRequirements).toEqual([
      {
        kind: "oauth",
        componentKey: "server:crm",
        serverKey: "crm",
        timing: "on_install",
      },
    ]);
  });

  it("drops nested secrets inside oauth metadata (hashed config)", async () => {
    const parsed = await parsePluginBundle(
      withMcp({
        crm: {
          type: "streamable-http",
          url: "https://crm.example.com/mcp",
          oauth: {
            authorization_server: "https://auth.example.com",
            extra: { api_key: "sk_live_deep_secret" },
          },
        },
      })
    );
    const config = parsed.mcpServers[0].config;
    if (config.transport === "http") {
      expect(config.oauth?.metadata).toEqual({
        authorization_server: "https://auth.example.com",
        extra: {},
      });
    }
    expect(JSON.stringify(parsed)).not.toContain("sk_live_deep_secret");
  });
});

describe("secret hygiene", () => {
  it("does not store a secret with a placeholder smuggled in", async () => {
    const parsed = await parsePluginBundle(
      withMcp({
        local: {
          type: "stdio",
          command: "node",
          env: { API_KEY: "sk-live-abc${PLUGIN_ROOT}" },
        },
      })
    );
    expect(parsed.mcpServers[0].config).toEqual({
      transport: "stdio",
      command: "node",
      args: [],
      // Dropped literal: name only, no valueTemplate, no value — and
      // required, because the bundle declared a value the user must replace.
      envRequirements: [{ name: "API_KEY", required: true }],
    });
    expect(JSON.stringify(parsed)).not.toContain("sk-live-abc");
    expect(
      parsed.warnings.some((issue) => issue.code === "MCP_ENV_VALUE_OMITTED")
    ).toBe(true);
  });

  it("registers composite env references as required setup", async () => {
    const parsed = await parsePluginBundle(
      withMcp({
        db: {
          type: "stdio",
          command: "node",
          env: { CONN: "postgres://${DB_HOST}:${DB_PORT}/x" },
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
        db: {
          type: "stdio",
          command: "node",
          env: { CONN: "sk-live-aaaabbbbccccdddd${DB_HOST}" },
        },
      })
    );
    const config = parsed.mcpServers[0].config;
    if (config.transport === "stdio") {
      expect(config.envRequirements).toEqual([
        { name: "CONN", required: true },
      ]);
    }
    expect(JSON.stringify(parsed)).not.toContain("sk-live-aaaabbbbccccdddd");
  });

  it("marks a header secret when its VALUE looks secret under an innocuous name", async () => {
    const parsed = await parsePluginBundle(
      withMcp({
        api: {
          type: "streamable-http",
          url: "https://api.example.com/mcp",
          headers: { "X-Custom": "Bearer sk-live-abc123" },
        },
      })
    );
    const config = parsed.mcpServers[0].config;
    if (config.transport === "http") {
      // Dropped AND flagged secret, so setup UIs mask the re-entered value.
      expect(config.headerRequirements).toEqual([
        { name: "X-Custom", secret: true },
      ]);
    }
    expect(JSON.stringify(parsed)).not.toContain("sk-live-abc123");
    expect(
      parsed.warnings.some(
        (issue) => issue.code === "MCP_HEADER_VALUE_OMITTED"
      )
    ).toBe(true);
  });
});

describe("limits and hash stability", () => {
  it("enforces the max MCP server count as a bundle error", async () => {
    const servers: Record<string, unknown> = {};
    for (let i = 0; i < 3; i++) {
      servers[`server-${i}`] = {
        type: "streamable-http",
        url: `https://s${i}.example.com/mcp`,
      };
    }
    await expectParseError(withMcp(servers), "MCP_TOO_MANY_SERVERS", {
      limits: { maxMcpServers: 2 },
    });
  });

  it("counts DECLARED entries — invalid ones cannot bypass the limit", async () => {
    const servers: Record<string, unknown> = {
      good: { type: "streamable-http", url: "https://ok.example.com/mcp" },
    };
    for (let i = 0; i < 4; i++) {
      servers[`broken-${i}`] = { type: "websocket" };
    }
    await expectParseError(withMcp(servers), "MCP_TOO_MANY_SERVERS", {
      limits: { maxMcpServers: 2 },
    });
  });

  it("produces the same configHash regardless of env key source order", async () => {
    const forward = await parsePluginBundle(
      withMcp({
        s: {
          type: "stdio",
          command: "node",
          env: { A_VAR: "${A_VAR}", B_VAR: "${B_VAR}" },
        },
      })
    );
    const reversed = await parsePluginBundle(
      withMcp({
        s: {
          type: "stdio",
          command: "node",
          env: { B_VAR: "${B_VAR}", A_VAR: "${A_VAR}" },
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
          type: "streamable-http",
          url: "https://api.example.com/mcp",
          headers: { Accept: "${ACCEPT}", "X-Api-Key": "${X_API_KEY}" },
        },
      })
    );
    const reversed = await parsePluginBundle(
      withMcp({
        s: {
          type: "streamable-http",
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
