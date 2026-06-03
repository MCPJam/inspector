import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Host } from "../src/host-config/index";
// Cross-entry check uses the browser entry (the Node `../src/index` barrel
// transitively imports `.md` skill files that vitest's transform can't load;
// the published `@mcpjam/sdk` main export is covered by `test:packaging`).
import { Host as HostFromBrowser } from "../src/browser";

type FixtureRow = { label: string; canonicalJson: string; sha256: string };
type Fixture = { rows: FixtureRow[] };

const here = dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(
  readFileSync(
    join(here, "fixtures", "host-config-parity-fixtures.json"),
    "utf8",
  ),
) as Fixture;

const rowByLabel = (label: string): FixtureRow => {
  const row = fixture.rows.find((r) => r.label === label);
  if (!row) throw new Error(`missing fixture row: ${label}`);
  return row;
};

describe("Host — public surface", () => {
  it("is exported from both @mcpjam/sdk/host-config and @mcpjam/sdk/browser", () => {
    expect(Host).toBe(HostFromBrowser);
  });

  it("chains setters and accumulates servers", () => {
    const host = new Host().addServer("a").addServer("b");
    expect(host).toBeInstanceOf(Host);
    expect(host.toJSON().serverIds).toEqual(["a", "b"]);
  });

  it("maps `mcp` (spec vocab) onto the internal `mcpProfile` wire field", async () => {
    const host = new Host().setMcp({ protocolVersion: "2025-06-18" });
    const json = host.toJSON();
    // Wire field stays `mcpProfile` (option b); profileVersion is supplied.
    expect(json.mcpProfile?.profileVersion).toBe(1);
    expect(json.mcpProfile?.mcpProtocolVersion).toBe("2025-06-18");
    // Stateful pin derivation still runs through the facade.
    expect(json.mcpProfile?.initialize?.supportedProtocolVersions).toEqual([
      "2025-06-18",
    ]);
    expect(typeof (await host.hash())).toBe("string");
  });

  it("validates lazily at toJSON() (invalid profile throws)", () => {
    const host = new Host().setMcp({
      // availableDisplayModes must be non-empty.
      apps: { mcpAppsOverrides: { availableDisplayModes: [] } },
    });
    expect(() => host.toJSON()).toThrow(/must contain at least one mode/);
  });
});

describe("Host — golden-vector equivalence (facade == canonicalizer)", () => {
  it("reproduces the `mcp-profile-initialize-order-preserved` vector", async () => {
    const row = rowByLabel("mcp-profile-initialize-order-preserved");
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
    expect(JSON.stringify(host.toJSON())).toBe(row.canonicalJson);
    expect(await host.hash()).toBe(row.sha256);
  });

  it("reproduces the `server-ids-unsorted-plus-overrides` vector", async () => {
    const row = rowByLabel("server-ids-unsorted-plus-overrides");
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
    expect(JSON.stringify(host.toJSON())).toBe(row.canonicalJson);
    expect(await host.hash()).toBe(row.sha256);
  });

  it("reproduces the `base-minimal` vector from HostInit alone", async () => {
    const row = rowByLabel("base-minimal");
    const host = new Host({
      style: "claude",
      model: "anthropic/claude-sonnet-4-6",
      systemPrompt: "You are a helpful assistant.",
    });
    expect(JSON.stringify(host.toJSON())).toBe(row.canonicalJson);
    expect(await host.hash()).toBe(row.sha256);
  });
});
