import { Host } from "../src/host-config/index";
import type { HostMcp } from "../src/host-config/index";
// Cross-entry check uses the browser entry (the Node `../src/index` barrel
// transitively imports `.md` skill files that vitest's transform can't load;
// the published `@mcpjam/sdk` main export is covered by `test:packaging`).
import { Host as HostFromBrowser } from "../src/browser";

describe("Host — public surface", () => {
  it("is exported from both @mcpjam/sdk/host-config and @mcpjam/sdk/browser", () => {
    expect(Host).toBe(HostFromBrowser);
  });

  it("chains setters and accumulates servers (public `servers` field)", () => {
    const host = new Host({ style: "mcpjam", model: "test-model" })
      .addServer("a")
      .addServer("b");
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
    const host = new Host({ style: "mcpjam", model: "test-model" }).setMcp({
      apps: { mcpAppsOverrides: { availableDisplayModes: [] } },
    });
    expect(() => host.toJSON()).toThrow(/must contain at least one mode/);
  });

  it("throws if `style` is not set (no silent SDK default)", () => {
    const noStyle = new Host().setModel("test-model");
    expect(() => noStyle.toJSON()).toThrow(/requires a `style`/);
  });

  it("throws if `model` is not set (no silent SDK default)", () => {
    const noModel = new Host().setStyle("mcpjam");
    expect(() => noModel.toJSON()).toThrow(/requires a `model`/);
  });

  it("normalizes server ids: sorts, dedupes empty overrides, sorts header keys", () => {
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

    const json = host.toJSON();
    expect(json.servers).toEqual(["srv-a", "srv-b", "srv-c"]);
    expect(json.optionalServers).toEqual(["opt-a", "opt-z"]);
    expect(json.serverOverrides?.["srv-a"]).toBeUndefined();
    expect(json.serverOverrides?.["srv-b"]).toEqual({
      headers: { A: "2", Z: "1" },
      requestTimeout: 5000,
      protocolVersion: "2025-06-18",
    });
  });
});

describe("Host — toJSON() round-trips", () => {
  it("new Host(host.toJSON()) reproduces the same JSON", () => {
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
    expect(rebuilt.toJSON()).toEqual(json1);
  });
});

describe("Host — deterministic under post-construction input mutation", () => {
  it("snapshots object inputs so later caller mutations don't leak in", () => {
    const mcp: HostMcp = {
      protocolVersion: "2025-06-18",
      apps: { compatRuntime: { openaiApps: true } },
    };
    const clientCapabilities = { sampling: { tools: {} } };
    const host = new Host({
      style: "chatgpt",
      model: "openai/gpt-5",
      mcp,
      clientCapabilities,
    });
    const jsonBefore = JSON.stringify(host.toJSON());

    // Mutate the very objects the caller handed to the constructor.
    (mcp.apps!.compatRuntime as { openaiApps?: boolean }).openaiApps = false;
    (clientCapabilities.sampling as { tools: unknown }).tools = { added: true };

    expect(JSON.stringify(host.toJSON())).toBe(jsonBefore);
  });

  it("snapshots setter inputs too", () => {
    const caps = { a: { b: 1 } };
    const host = new Host({ style: "mcpjam", model: "test-model" })
      .setClientCapabilities(caps);
    const jsonBefore = JSON.stringify(host.toJSON());
    (caps.a as { b: number }).b = 2;
    expect(JSON.stringify(host.toJSON())).toBe(jsonBefore);
  });
});
