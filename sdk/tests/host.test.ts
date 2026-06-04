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

  it("accumulates servers via addServer chaining", () => {
    const host = new Host({ style: "mcpjam", model: "test-model" })
      .addServer("a")
      .addServer("b");
    expect(host).toBeInstanceOf(Host);
    expect(host.toJSON().servers).toEqual(["a", "b"]);
  });

  it("supports direct property mutation on every public field", () => {
    const host = new Host({ style: "mcpjam", model: "test-model" });
    host.systemPrompt = "You are helpful.";
    host.temperature = 0.2;
    host.requireToolApproval = true;
    host.servers.push("srv_a");
    host.mcp.protocolVersion = "2025-11-25";
    host.mcp.apps = { sandbox: { csp: { mode: "declared" } } };
    host.serverOverrides["srv_a"] = { requestTimeout: 1234 };

    const json = host.toJSON();
    expect(json.systemPrompt).toBe("You are helpful.");
    expect(json.temperature).toBe(0.2);
    expect(json.requireToolApproval).toBe(true);
    expect(json.servers).toEqual(["srv_a"]);
    expect(json.mcp?.protocolVersion).toBe("2025-11-25");
    expect(json.mcp?.apps?.sandbox?.csp?.mode).toBe("declared");
    expect(json.serverOverrides?.srv_a?.requestTimeout).toBe(1234);
  });

  it("dedupes server ids added through direct array mutation", () => {
    const host = new Host({ style: "mcpjam", model: "test-model" });
    host.servers.push("srv_b", "srv_a", "srv_b");
    host.optionalServers.push("opt_b", "opt_a", "opt_a");

    expect(host.toJSON().servers).toEqual(["srv_a", "srv_b"]);
    expect(host.toJSON().optionalServers).toEqual(["opt_a", "opt_b"]);
  });

  it("untouched mcp is omitted from toJSON (empty default collapses)", () => {
    const json = new Host({ style: "mcpjam", model: "test-model" }).toJSON();
    expect(json.mcp).toBeUndefined();
  });

  it("exposes only public MCP vocabulary in toJSON() — no impl names leak", () => {
    const host = new Host({
      style: "chatgpt",
      model: "openai/gpt-5",
    });
    host.mcp.protocolVersion = "2025-06-18";
    host.addServer("srv_a");
    host.setServerOverride("srv_a", {
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
    const host = new Host({ style: "mcpjam", model: "test-model" });
    host.mcp.apps = { mcpAppsOverrides: { availableDisplayModes: [] } };
    expect(() => host.toJSON()).toThrow(/must contain at least one mode/);
  });

  it("validates per-server request timeout overrides at toJSON()", () => {
    const host = new Host({ style: "mcpjam", model: "test-model" })
      .addServer("srv_a")
      .setServerOverride("srv_a", { requestTimeout: Infinity });

    expect(() => host.toJSON()).toThrow(/requestTimeoutOverride must be finite/);
  });

  it("throws if `style` is not set (no silent SDK default)", () => {
    const noStyle = new Host();
    noStyle.model = "test-model";
    expect(() => noStyle.toJSON()).toThrow(/requires a `style`/);
  });

  it("throws if `model` is not set (no silent SDK default)", () => {
    const noModel = new Host();
    noModel.style = "mcpjam";
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
      .setServerOverride("srv-b", {
        headers: { Z: "1", A: "2" },
        requestTimeout: 5000,
        protocolVersion: "2025-06-18",
      })
      .setServerOverride("srv-a", {});

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

describe("Host — mutation helpers", () => {
  it("addServer dedupes (idempotent)", () => {
    const host = new Host({ style: "mcpjam", model: "test-model" })
      .addServer("a")
      .addServer("a")
      .addServer("b")
      .addServer("a");
    expect(host.servers).toEqual(["a", "b"]);
    expect(host.toJSON().servers).toEqual(["a", "b"]);
  });

  it("addOptionalServer dedupes (idempotent)", () => {
    const host = new Host({ style: "mcpjam", model: "test-model" })
      .addOptionalServer("z")
      .addOptionalServer("z");
    expect(host.optionalServers).toEqual(["z"]);
  });

  it("constructor dedupes servers and optionalServers from init", () => {
    const host = new Host({
      style: "mcpjam",
      model: "test-model",
      servers: ["a", "b", "a", "c"],
      optionalServers: ["x", "x", "y"],
    });
    expect(host.servers).toEqual(["a", "b", "c"]);
    expect(host.optionalServers).toEqual(["x", "y"]);
  });

  it("removeServer / removeOptionalServer are no-ops when absent", () => {
    const host = new Host({ style: "mcpjam", model: "test-model" })
      .addServer("a")
      .addServer("b");
    host.removeServer("missing");
    host.removeServer("a");
    expect(host.servers).toEqual(["b"]);

    host.addOptionalServer("opt");
    host.removeOptionalServer("nope");
    host.removeOptionalServer("opt");
    expect(host.optionalServers).toEqual([]);
  });

  it("removeServerOverride drops the entry from toJSON", () => {
    const host = new Host({ style: "mcpjam", model: "test-model" })
      .addServer("a")
      .setServerOverride("a", { requestTimeout: 1000 });
    expect(host.toJSON().serverOverrides?.a?.requestTimeout).toBe(1000);
    host.removeServerOverride("a");
    expect(host.toJSON().serverOverrides).toBeUndefined();
  });

  it("clearMcp resets mcp to {} and drops it from toJSON", () => {
    const host = new Host({ style: "mcpjam", model: "test-model" });
    host.mcp.protocolVersion = "2025-11-25";
    expect(host.toJSON().mcp).toBeDefined();
    host.clearMcp();
    expect(host.mcp).toEqual({});
    expect(host.toJSON().mcp).toBeUndefined();
  });
});

describe("Host — toJSON() round-trips", () => {
  it("new Host(host.toJSON()) reproduces the same JSON", () => {
    const host = new Host({ style: "chatgpt", model: "openai/gpt-5" })
      .addServer("srv-b")
      .addServer("srv-a")
      .setServerOverride("srv-a", { requestTimeout: 1234 });
    host.mcp.protocolVersion = "2025-06-18";
    host.mcp.apps = { compatRuntime: { openaiApps: true } };

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

  it("snapshots at toJSON() so a direct-property mutation between two calls is observable", () => {
    // Sanity: direct mutation IS visible to later toJSON() calls (that's the
    // whole point), but each toJSON() call sees a stable snapshot of the
    // host's state at that moment.
    const host = new Host({ style: "mcpjam", model: "test-model" });
    host.mcp.protocolVersion = "2025-06-18";
    const before = host.toJSON();
    expect(before.mcp?.protocolVersion).toBe("2025-06-18");

    host.mcp.protocolVersion = "2025-11-25";
    const after = host.toJSON();
    expect(after.mcp?.protocolVersion).toBe("2025-11-25");

    // Earlier snapshot is unchanged.
    expect(before.mcp?.protocolVersion).toBe("2025-06-18");
  });
});
