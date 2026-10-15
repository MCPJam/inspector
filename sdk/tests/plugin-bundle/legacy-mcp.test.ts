/**
 * Legacy MCP configuration under the openai-compatible profile: Codex and
 * Claude `.mcp.json` dialects rewritten for the strict normalizer, one entry
 * at a time.
 */

import { describe, expect, it } from "vitest";
import {
  parsePluginBundle,
  type ParsedPluginBundle,
} from "../../src/plugin-bundle/index.js";
import { bitsAndBoltsCodexFiles } from "./compat-fixtures.js";
import { bundle, expectParseError, manifestJson, mcpJson } from "./fixtures.js";

const compat = { profile: "openai-compatible" } as const;
const CODEX = ".codex-plugin/plugin.json";

function codexBundle(
  servers: Record<string, unknown>,
  extra: Record<string, string> = {}
) {
  return bundle({
    [CODEX]: JSON.stringify({ name: "demo" }),
    ".mcp.json": JSON.stringify({ mcpServers: servers }),
    ...extra,
  });
}

const configOf = (parsed: ParsedPluginBundle, key: string) =>
  parsed.mcpServers.find((server) => server.key === key)?.config;

describe("legacy .mcp.json", () => {
  it("reads the pinned Bits & Bolts stdio server, cwd '.' as the plugin root", async () => {
    const parsed = await parsePluginBundle(
      bundle(bitsAndBoltsCodexFiles()),
      compat
    );
    expect(parsed.mcpServers).toEqual([
      expect.objectContaining({
        key: "bits-and-bolts",
        componentKey: "server:bits-and-bolts",
        sourcePath: ".mcp.json",
        config: {
          transport: "stdio",
          command: "node",
          args: ["./dist/server.js"],
          envRequirements: [],
          workingDirectory: "${PLUGIN_ROOT}",
        },
      }),
    ]);
    expect(parsed.skipped).toEqual([]);
    expect(parsed.warnings).toEqual([]);
  });

  it.each([
    ["http", "streamable-http"],
    ["streamable_http", "streamable-http"],
    ["streamableHttp", "streamable-http"],
    ["streamable-http", "streamable-http"],
    ["sse", "sse"],
  ])(
    "writes legacy type %j as the strict %j transport",
    async (type, httpVariant) => {
      const parsed = await parsePluginBundle(
        codexBundle({ remote: { type, url: "https://mcp.example.com/mcp" } }),
        compat
      );
      expect(configOf(parsed, "remote")).toMatchObject({
        transport: "http",
        httpVariant,
        url: "https://mcp.example.com/mcp",
      });
    }
  );

  it("infers an absent legacy type from command or url", async () => {
    const parsed = await parsePluginBundle(
      codexBundle({
        local: { command: "node", args: ["server.js"] },
        remote: { url: "https://mcp.example.com/mcp" },
      }),
      compat
    );
    expect(configOf(parsed, "local")).toMatchObject({ transport: "stdio" });
    expect(configOf(parsed, "remote")).toMatchObject({
      httpVariant: "streamable-http",
    });
  });

  it("skips a disabled server with its reason and keeps its siblings", async () => {
    const parsed = await parsePluginBundle(
      codexBundle({
        off: { command: "node", disabled: true },
        alsoOff: { url: "https://a.example.com/mcp", enabled: false },
        on: { command: "node" },
      }),
      compat
    );
    expect(parsed.mcpServers.map((server) => server.key)).toEqual(["on"]);
    expect(parsed.skipped).toEqual([
      {
        kind: "server",
        key: "off",
        reason: "it is disabled in its configuration",
      },
      {
        kind: "server",
        key: "alsoOff",
        reason: "it is disabled in its configuration",
      },
    ]);
  });

  it("reports a server keyed __proto__ instead of losing it", async () => {
    // Written as text: an object literal would set the prototype instead.
    const parsed = await parsePluginBundle(
      bundle({
        [CODEX]: JSON.stringify({ name: "demo" }),
        ".mcp.json":
          '{"mcpServers":{"__proto__":{"command":"node"},"good":{"command":"node"}}}',
      }),
      compat
    );
    expect(parsed.mcpServers.map((server) => server.key)).toEqual(["good"]);
    expect(parsed.skipped).toEqual([
      expect.objectContaining({ kind: "server", key: "__proto__" }),
    ]);
  });

  it("reads an entry with a very long args list without throwing", async () => {
    const parsed = await parsePluginBundle(
      codexBundle({
        long: { command: "node", args: Array(200_000).fill("1") },
        good: { command: "node" },
      }),
      compat
    );
    expect(parsed.mcpServers.map((server) => server.key)).toContain("good");
  });

  it.each([
    [
      "a deeply nested args array",
      `{"command":"node","args":${"[".repeat(100_000)}"x"${"]".repeat(100_000)}}`,
    ],
    [
      "an env value with its own toString",
      '{"command":"node","env":{"X":{"toString":1}}}',
    ],
  ])("skips only an entry with %s", async (_label, entry) => {
    const parsed = await parsePluginBundle(
      bundle({
        [CODEX]: JSON.stringify({ name: "demo" }),
        ".mcp.json": `{"mcpServers":{"bad":${entry},"good":{"command":"node"}}}`,
      }),
      compat
    );
    expect(parsed.mcpServers.map((server) => server.key)).toEqual(["good"]);
  });

  it.each([
    [
      "command and url with no type",
      { command: "node", url: "https://a.example.com" },
    ],
    [
      "an http type with a command",
      { type: "http", url: "https://a.example.com", command: "node" },
    ],
    [
      "a stdio type with a url",
      { type: "stdio", command: "node", url: "https://a.example.com" },
    ],
  ])("skips an entry declaring %s, alone", async (_label, contradictory) => {
    const parsed = await parsePluginBundle(
      codexBundle({ bad: contradictory, good: { command: "node" } }),
      compat
    );
    expect(parsed.mcpServers.map((server) => server.key)).toEqual(["good"]);
    expect(parsed.skipped).toEqual([
      expect.objectContaining({ kind: "server", key: "bad" }),
    ]);
  });

  it("still applies the strict entry rules after the rewrite", async () => {
    const parsed = await parsePluginBundle(
      codexBundle({
        insecure: { type: "http", url: "http://mcp.example.com/mcp" },
        "Bad Name": { command: "node" },
        secret: {
          type: "http",
          url: "https://mcp.example.com/mcp",
          headers: { Authorization: "Bearer sk-live-legacy-literal" },
        },
      }),
      compat
    );
    expect(parsed.mcpServers.map((server) => server.key)).toEqual(["secret"]);
    expect(parsed.skipped.map((skip) => skip.key).sort()).toEqual([
      "Bad Name",
      "insecure",
    ]);
    expect(JSON.stringify(parsed)).not.toContain("sk-live-legacy-literal");
    expect(parsed.setupRequirements).toEqual([
      expect.objectContaining({ kind: "header", name: "Authorization" }),
    ]);
  });

  it("drops keys the strict schema does not know, with a warning", async () => {
    const parsed = await parsePluginBundle(
      codexBundle({
        local: { command: "node", timeout: 30, description: "local server" },
      }),
      compat
    );
    expect(parsed.mcpServers).toHaveLength(1);
    expect(
      parsed.warnings.filter((w) => w.code === "MCP_UNKNOWN_FIELD")
    ).toEqual([
      expect.objectContaining({ severity: "warning" }),
      expect.objectContaining({ severity: "warning" }),
    ]);
  });

  it("normalizes legacy working directories and refuses escaping ones", async () => {
    const parsed = await parsePluginBundle(
      codexBundle({
        nested: { command: "node", cwd: "server" },
        escape: { command: "node", cwd: "../outside" },
      }),
      compat
    );
    expect(configOf(parsed, "nested")).toMatchObject({
      workingDirectory: "${PLUGIN_ROOT}/server",
    });
    expect(parsed.skipped.map((skip) => skip.key)).toEqual(["escape"]);
  });

  it("reads MCP servers from the location the manifest declares", async () => {
    const parsed = await parsePluginBundle(
      bundle({
        [CODEX]: JSON.stringify({
          name: "demo",
          mcpServers: "./config/mcp.json",
        }),
        "config/mcp.json": JSON.stringify({
          mcpServers: { local: { command: "node" } },
        }),
      }),
      compat
    );
    expect(parsed.mcpServers).toEqual([
      expect.objectContaining({ key: "local", sourcePath: "config/mcp.json" }),
    ]);
    // The declared file is the configuration, not an ignored nested mcp.json.
    expect(parsed.warnings).toEqual([]);
  });

  it("invalidates MCP servers when the declared location escapes the package", async () => {
    const parsed = await parsePluginBundle(
      bundle({
        [CODEX]: JSON.stringify({ name: "demo", mcpServers: "../mcp.json" }),
        ".mcp.json": JSON.stringify({ mcpServers: { x: { command: "node" } } }),
      }),
      compat
    );
    expect(parsed.mcpServers).toEqual([]);
    expect(parsed.skipped).toEqual([
      expect.objectContaining({ kind: "mcp-config", key: CODEX }),
    ]);
    expect(parsed.warnings.map((w) => w.code)).toContain("PATH_ESCAPES_ROOT");
  });

  it("reports a declared location that is not in the package", async () => {
    const parsed = await parsePluginBundle(
      bundle({
        [CODEX]: JSON.stringify({ name: "demo", mcpServers: "./servers.json" }),
      }),
      compat
    );
    expect(parsed.mcpServers).toEqual([]);
    expect(parsed.warnings.map((w) => w.code)).toEqual([
      "MANIFEST_MISSING_FILE",
    ]);
  });

  it("disables only MCP when .mcp.json is unusable, keeping skills", async () => {
    const files = bitsAndBoltsCodexFiles();
    for (const content of [
      "{ not json",
      JSON.stringify({ mcpServers: {}, mcp_servers: {} }),
    ]) {
      const parsed = await parsePluginBundle(
        bundle({ ...files, ".mcp.json": content }),
        compat
      );
      expect(parsed.skills).toHaveLength(2);
      expect(parsed.mcpServers).toEqual([]);
      expect(parsed.skipped).toEqual([
        expect.objectContaining({ kind: "mcp-config", key: ".mcp.json" }),
      ]);
    }
  });

  it("enforces the server cap on declared legacy entries", async () => {
    await expectParseError(
      codexBundle({ a: { command: "node" }, b: { command: "node" } }),
      "MCP_TOO_MANY_SERVERS",
      { ...compat, limits: { maxMcpServers: 1 } }
    );
  });

  it("never reads a root mcp.json for a legacy package", async () => {
    const parsed = await parsePluginBundle(
      bundle({
        [CODEX]: JSON.stringify({ name: "demo" }),
        "mcp.json": mcpJson({ portable: { type: "stdio", command: "node" } }),
      }),
      compat
    );
    expect(parsed.mcpServers).toEqual([]);
    expect(parsed.warnings.map((w) => w.code)).toEqual(["MCP_CONFIG_IGNORED"]);
  });
});

describe("Claude plugin MCP configuration", () => {
  const claude = (manifest: Record<string, unknown>, mcp?: unknown) =>
    bundle({
      ".claude-plugin/plugin.json": JSON.stringify({
        name: "db-tools",
        ...manifest,
      }),
      ...(mcp === undefined ? {} : { ".mcp.json": JSON.stringify(mcp) }),
    });

  it("maps CLAUDE_PLUGIN_ROOT and CLAUDE_PLUGIN_DATA to the portable placeholders", async () => {
    const parsed = await parsePluginBundle(
      claude(
        {},
        {
          mcpServers: {
            db: {
              command: "${CLAUDE_PLUGIN_ROOT}/servers/db",
              args: ["--config", "${CLAUDE_PLUGIN_ROOT}/config.json"],
              env: { CACHE_DIR: "${CLAUDE_PLUGIN_DATA}/cache" },
              cwd: "${CLAUDE_PLUGIN_ROOT}",
            },
          },
        }
      ),
      compat
    );
    expect(configOf(parsed, "db")).toEqual({
      transport: "stdio",
      command: "${PLUGIN_ROOT}/servers/db",
      args: ["--config", "${PLUGIN_ROOT}/config.json"],
      envRequirements: [
        {
          name: "CACHE_DIR",
          required: false,
          valueTemplate: "${PLUGIN_DATA}/cache",
        },
      ],
      workingDirectory: "${PLUGIN_ROOT}",
    });
  });

  it("checks containment of a placeholder-rooted command", async () => {
    const parsed = await parsePluginBundle(
      claude(
        {},
        {
          mcpServers: {
            evil: { command: "${CLAUDE_PLUGIN_ROOT}/../../bin/sh" },
          },
        }
      ),
      compat
    );
    expect(parsed.mcpServers).toEqual([]);
    expect(parsed.warnings.map((w) => w.code)).toContain("PATH_ESCAPES_ROOT");
  });

  it("skips a server that needs Claude's user_config values", async () => {
    const parsed = await parsePluginBundle(
      claude(
        {},
        {
          mcpServers: {
            api: { command: "node", env: { KEY: "${user_config.api_key}" } },
          },
        }
      ),
      compat
    );
    expect(parsed.skipped).toEqual([
      expect.objectContaining({
        key: "api",
        reason: expect.stringContaining("user_config"),
      }),
    ]);
  });

  it("reads an inline mcpServers object from the manifest", async () => {
    const parsed = await parsePluginBundle(
      claude({ mcpServers: { db: { command: "node", args: ["db.js"] } } }),
      compat
    );
    expect(parsed.mcpServers).toEqual([
      expect.objectContaining({
        key: "db",
        sourcePath: ".claude-plugin/plugin.json",
      }),
    ]);
  });
});

describe("portable mcp.json under the compatible profile", () => {
  it("is never inferred or folded", async () => {
    const parsed = await parsePluginBundle(
      bundle({
        "plugin.json": manifestJson(),
        "mcp.json": mcpJson({
          untyped: { url: "https://a.example.com/mcp" },
          folded: { type: "http", url: "https://b.example.com/mcp" },
        }),
      }),
      compat
    );
    expect(parsed.mcpServers).toEqual([]);
    expect(parsed.skipped.map((skip) => skip.key).sort()).toEqual([
      "folded",
      "untyped",
    ]);
  });
});
