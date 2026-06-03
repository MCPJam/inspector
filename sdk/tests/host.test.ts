import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Host } from "../src/host-config/index";
// Cross-entry check uses the browser entry (the Node `../src/index` barrel
// transitively imports `.md` skill files that vitest's transform can't load;
// the published `@mcpjam/sdk` main export is covered by `test:packaging`).
import { Host as HostFromBrowser } from "../src/browser";

type FixtureRow = { label: string; sha256: string };
type Fixture = { rows: FixtureRow[] };

const here = dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(
  readFileSync(
    join(here, "fixtures", "host-config-parity-fixtures.json"),
    "utf8",
  ),
) as Fixture;

const sha = (label: string): string => {
  const row = fixture.rows.find((r) => r.label === label);
  if (!row) throw new Error(`missing fixture row: ${label}`);
  return row.sha256;
};

describe("Host — public surface", () => {
  it("is exported from both @mcpjam/sdk/host-config and @mcpjam/sdk/browser", () => {
    expect(Host).toBe(HostFromBrowser);
  });

  it("chains setters and accumulates servers (public `servers` field)", () => {
    const host = new Host().addServer("a").addServer("b");
    expect(host).toBeInstanceOf(Host);
    expect(host.toJSON().servers).toEqual(["a", "b"]);
  });

  it("exposes only public MCP vocabulary in toJSON() — no impl names leak", () => {
    const host = new Host({
      style: "chatgpt",
      model: "openai/gpt-5",
    })
      .setMcp({ protocolVersion: "2025-06-18" })
      .addServer("srv_a")
      .addServerOverride("srv_a", {
        headers: { A: "1" },
        protocolVersion: "2025-11-25",
      });
    const json = host.toJSON();

    // Public vocabulary present.
    expect(json.mcp?.protocolVersion).toBe("2025-06-18");
    // Stateful pin derivation still runs (normalized output).
    expect(json.mcp?.initialize?.supportedProtocolVersions).toEqual([
      "2025-06-18",
    ]);
    expect(json.serverOverrides?.srv_a?.headers).toEqual({ A: "1" });
    expect(json.serverOverrides?.srv_a?.protocolVersion).toBe("2025-11-25");

    // No storage-row / implementation names anywhere in the serialized output.
    const str = JSON.stringify(json);
    for (const impl of [
      "mcpProfile",
      "profileVersion",
      "schemaVersion",
      "mcpProtocolVersion",
      "serverIds",
      "hostStyle",
      "modelId",
      "headersOverride",
      "serverConnectionOverrides",
    ]) {
      expect(str).not.toContain(impl);
    }
  });

  it("validates lazily at toJSON() (invalid profile throws)", () => {
    const host = new Host().setMcp({
      apps: { mcpAppsOverrides: { availableDisplayModes: [] } },
    });
    expect(() => host.toJSON()).toThrow(/must contain at least one mode/);
  });
});

describe("Host — fingerprint matches the golden vectors", () => {
  // hash() is computed over the internal canonical form, so it must equal the
  // pinned golden sha256 (proving the facade preserves backend parity).
  it("base-minimal", async () => {
    const host = new Host({
      style: "claude",
      model: "anthropic/claude-sonnet-4-6",
      systemPrompt: "You are a helpful assistant.",
    });
    expect(await host.hash()).toBe(sha("base-minimal"));
  });

  it("mcp-profile-initialize-order-preserved", async () => {
    const host = new Host({
      style: "claude",
      model: "anthropic/claude-sonnet-4-6",
      systemPrompt: "You are a helpful assistant.",
    }).setMcp({
      initialize: {
        supportedProtocolVersions: ["2025-11-25", "2025-06-18"],
        clientInfo: { version: "1.2.3", name: "mcpjam", title: "MCPJam" },
      },
    });
    expect(await host.hash()).toBe(sha("mcp-profile-initialize-order-preserved"));
  });

  it("server-ids-unsorted-plus-overrides", async () => {
    const host = new Host({
      style: "claude",
      model: "anthropic/claude-sonnet-4-6",
      systemPrompt: "You are a helpful assistant.",
    })
      .addServer("srv-c")
      .addServer("srv-a")
      .addServer("srv-b")
      .addOptionalServer("opt-z")
      .addOptionalServer("opt-a")
      .addServerOverride("srv-b", {
        headers: { Z: "1", A: "2" },
        requestTimeout: 5000,
        protocolVersion: "2025-06-18",
      })
      .addServerOverride("srv-a", {});
    expect(await host.hash()).toBe(sha("server-ids-unsorted-plus-overrides"));
  });
});

describe("Host — toJSON() round-trips", () => {
  it("new Host(host.toJSON()) reproduces the same JSON and hash", async () => {
    const host = new Host({ style: "chatgpt", model: "openai/gpt-5" })
      .setMcp({
        protocolVersion: "2025-06-18",
        apps: { compatRuntime: { openaiApps: true } },
      })
      .addServer("srv-b")
      .addServer("srv-a")
      .addServerOverride("srv-a", { requestTimeout: 1234 });

    const json1 = host.toJSON();
    const rebuilt = new Host(json1);
    const json2 = rebuilt.toJSON();

    expect(json2).toEqual(json1);
    expect(await rebuilt.hash()).toBe(await host.hash());
  });
});
