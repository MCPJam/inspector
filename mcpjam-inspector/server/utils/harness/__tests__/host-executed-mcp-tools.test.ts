/**
 * COMP-39 — host-executed MCP delivery for the Codex harness.
 *
 * Every assertion here fails against the previous behaviour, where Codex had no
 * MCP delivery at all and a Codex host with selected servers was refused before
 * a turn ever opened.
 */
import { describe, expect, it, vi } from "vitest";
import { buildToolPolicySnapshot } from "@mcpjam/sdk/contract";
import {
  harnessMcpToolName,
  projectSelectedMcpServersAsHostTools,
} from "../host-executed-mcp-tools";
import {
  buildHarnessProxyMcpJson,
  parseHarnessToolName,
} from "../mcp-config";
import { getHarnessAdapter } from "../registry";

type FakeTool = {
  description?: string;
  execute: (input: unknown, options: unknown) => Promise<unknown>;
};

/** A manager stub exposing only what the projection consumes. */
function fakeManager(servers: Record<string, Record<string, FakeTool>>) {
  const getToolsForAiSdk = vi.fn(async (ids: string[]) => {
    const id = ids[0]!;
    // Mirrors the real manager: ONE call per server id, tools keyed by their
    // un-namespaced name.
    return { ...(servers[id] ?? {}) };
  });
  return {
    getServerConfig: vi.fn((id: string) =>
      Object.prototype.hasOwnProperty.call(servers, id) ? { url: "x" } : undefined
    ),
    getToolsForAiSdk,
  } as never as Parameters<
    typeof projectSelectedMcpServersAsHostTools
  >[0]["manager"] & {
    getToolsForAiSdk: typeof getToolsForAiSdk;
  };
}

function tool(result: unknown = { ok: true }): FakeTool {
  return { description: "d", execute: vi.fn(async () => result) };
}

describe("projectSelectedMcpServersAsHostTools", () => {
  it("names projected tools exactly as Claude Code namespaces its MCP tools", async () => {
    const manager = fakeManager({
      "weather-api": { get_forecast: tool() },
    });
    const projected = await projectSelectedMcpServersAsHostTools({
      manager,
      selectedServerIds: ["weather-api"],
    });

    // The name the model sees must be byte-identical to the one Claude Code's
    // own MCP client produces from the SAME server id, or a trace/eval
    // assertion written against a Claude Code run stops matching on Codex.
    const claudeKey = Object.keys(
      buildHarnessProxyMcpJson([
        { name: "weather-api", proxyUrl: "https://example.com/mcp" },
      ]).mcpServers
    )[0]!;
    expect(Object.keys(projected.tools)).toEqual([
      `mcp__${claudeKey}__get_forecast`,
    ]);
    // `sanitizeServerName` keeps hyphens, so this id survives unchanged.
    expect(Object.keys(projected.tools)[0]).toBe(
      "mcp__weather-api__get_forecast"
    );
  });

  it("round-trips a relayed call back to the right serverId via parseToolName", async () => {
    const manager = fakeManager({
      "weather-api": { get_forecast: tool() },
      "docs.server": { search: tool() },
    });
    const projected = await projectSelectedMcpServersAsHostTools({
      manager,
      selectedServerIds: ["weather-api", "docs.server"],
    });

    // This is what `runHarnessTurn` does with the name the codex bridge relays
    // back — through the ADAPTER, so the Codex adapter's own parseToolName is
    // the thing under test, not just the helper.
    const codex = getHarnessAdapter("codex");
    for (const name of Object.keys(projected.tools)) {
      const attribution = codex.parseToolName(name, projected.keyToServerId);
      expect(attribution.serverId).toBeDefined();
      expect(name).toBe(
        harnessMcpToolName(
          Object.entries(projected.keyToServerId).find(
            ([, serverId]) => serverId === attribution.serverId
          )![0],
          attribution.toolName
        )
      );
    }
    expect(
      codex.parseToolName(
        "mcp__weather-api__get_forecast",
        projected.keyToServerId
      )
    ).toEqual({ serverId: "weather-api", toolName: "get_forecast" });
    expect(
      codex.parseToolName("mcp__docs_server__search", projected.keyToServerId)
    ).toEqual({ serverId: "docs.server", toolName: "search" });
  });

  it("keeps same-named tools from two servers distinct (per-server enumeration)", async () => {
    // The manager's multi-id form flattens last-in-wins, which would silently
    // drop one of these. The projection must call it once per server.
    const manager = fakeManager({
      alpha: { search: tool("alpha") },
      beta: { search: tool("beta") },
    });
    const projected = await projectSelectedMcpServersAsHostTools({
      manager,
      selectedServerIds: ["alpha", "beta"],
    });
    expect(Object.keys(projected.tools).sort()).toEqual([
      "mcp__alpha__search",
      "mcp__beta__search",
    ]);
    expect(manager.getToolsForAiSdk).toHaveBeenCalledTimes(2);
    expect(manager.getToolsForAiSdk).toHaveBeenCalledWith(["alpha"]);
    expect(manager.getToolsForAiSdk).toHaveBeenCalledWith(["beta"]);
  });

  it("de-duplicates server keys that sanitize to the same name", async () => {
    const manager = fakeManager({
      "a.b": { t: tool() },
      "a-b": { t: tool() },
    });
    const projected = await projectSelectedMcpServersAsHostTools({
      manager,
      selectedServerIds: ["a.b", "a-b"],
    });
    expect(Object.keys(projected.tools)).toHaveLength(2);
    expect(new Set(Object.values(projected.keyToServerId))).toEqual(
      new Set(["a.b", "a-b"])
    );
  });

  it("executes through the manager's own tool, not a re-implementation", async () => {
    const inner = tool({ content: [{ type: "text", text: "hi" }] });
    const manager = fakeManager({ srv: { ping: inner } });
    const projected = await projectSelectedMcpServersAsHostTools({
      manager,
      selectedServerIds: ["srv"],
    });
    // No policy in force ⇒ the manager's tool object is passed through
    // untouched, so there is exactly one execution path for an MCP call.
    expect(projected.tools["mcp__srv__ping"]).toBe(inner);
  });

  it("skips a selected server with no live config rather than failing the turn", async () => {
    const manager = fakeManager({ live: { t: tool() } });
    const projected = await projectSelectedMcpServersAsHostTools({
      manager,
      selectedServerIds: ["live", "stale"],
    });
    expect(Object.keys(projected.tools)).toEqual(["mcp__live__t"]);
    expect(projected.keyToServerId).toEqual({ live: "live" });
  });

  it("returns nothing when no server is selected", async () => {
    const manager = fakeManager({});
    await expect(
      projectSelectedMcpServersAsHostTools({
        manager,
        selectedServerIds: [],
      })
    ).resolves.toEqual({ tools: {}, keyToServerId: {} });
    expect(manager.getToolsForAiSdk).not.toHaveBeenCalled();
  });

  describe("toolPolicy is enforced in-process (the proxy seal has no role here)", () => {
    const snapshot = buildToolPolicySnapshot({
      policy: { mode: "default", deny: ["delete_all"] },
      tools: [{ name: "delete_all" }, { name: "read_thing" }],
    });

    it("blocks a denied tool before it reaches the server", async () => {
      const denied = tool();
      const manager = fakeManager({
        srv: { delete_all: denied, read_thing: tool() },
      });
      const projected = await projectSelectedMcpServersAsHostTools({
        manager,
        selectedServerIds: ["srv"],
        toolPolicy: { srv: snapshot },
      });
      const gated = projected.tools["mcp__srv__delete_all"] as FakeTool;
      const result = (await gated.execute({}, {})) as {
        content: Array<{ text: string }>;
        _meta: Record<string, { reason: string }>;
      };
      expect(denied.execute).not.toHaveBeenCalled();
      // The SAME envelope the proxy answers with, so the turn's existing
      // detectors account it as blockedByPolicy rather than as a tool failure.
      expect(result.content[0]!.text).toMatch(/^Call blocked by tool policy: /);
      expect(result._meta["mcpjam/policyBlock"]!.reason).toBe("denyList");
    });

    it("lets an allowed tool through untouched", async () => {
      const allowed = tool("real result");
      const manager = fakeManager({ srv: { read_thing: allowed } });
      const projected = await projectSelectedMcpServersAsHostTools({
        manager,
        selectedServerIds: ["srv"],
        toolPolicy: { srv: snapshot },
      });
      const gated = projected.tools["mcp__srv__read_thing"] as FakeTool;
      await expect(gated.execute({ a: 1 }, {})).resolves.toBe("real result");
      expect(allowed.execute).toHaveBeenCalledWith({ a: 1 }, {});
    });

    it("blocks a tool that appeared after launch (unknownAtLaunch)", async () => {
      const late = tool();
      const manager = fakeManager({ srv: { brand_new: late } });
      const projected = await projectSelectedMcpServersAsHostTools({
        manager,
        selectedServerIds: ["srv"],
        toolPolicy: { srv: snapshot },
      });
      const gated = projected.tools["mcp__srv__brand_new"] as FakeTool;
      const result = (await gated.execute({}, {})) as {
        _meta: Record<string, { reason: string }>;
      };
      expect(late.execute).not.toHaveBeenCalled();
      expect(result._meta["mcpjam/policyBlock"]!.reason).toBe("unknownAtLaunch");
    });
  });
});

describe("harnessMcpToolName", () => {
  it("is the same scheme parseHarnessToolName reverses", () => {
    const name = harnessMcpToolName("weather", "get_forecast");
    expect(name).toBe("mcp__weather__get_forecast");
    expect(parseHarnessToolName(name, { weather: "srv-1" })).toEqual({
      serverId: "srv-1",
      toolName: "get_forecast",
    });
  });
});
