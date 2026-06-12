import { describe, expect, it, vi } from "vitest";
import {
  resolveHostTools,
  narrowHostComputer,
} from "../built-in-tools/registry";
import { WEB_SEARCH_TOOL_NAME } from "../built-in-tools/exa-web-search";
import { BASH_TOOL_NAME } from "../built-in-tools/bash";
import { MCPJAM_TOOL_IDS, type McpjamLiveOps } from "../built-in-tools/mcpjam";

const ctx = {
  authHeader: "Bearer token-123",
  projectId: "project-1",
  chatSessionId: "session-1",
};

function stubLiveOps(): McpjamLiveOps {
  return {
    diagnoseServer: vi.fn(async () => ({})),
    listTools: vi.fn(async () => ({})),
    callTool: vi.fn(async () => ({})),
    listPrompts: vi.fn(async () => ({})),
    getPrompt: vi.fn(async () => ({})),
    listResources: vi.fn(async () => ({})),
    readResource: vi.fn(async () => ({})),
  };
}

const computer = { kind: "personal", workdir: "/srv" };

describe("resolveHostTools — builtInToolIds", () => {
  it("resolves web_search to a runnable tool", () => {
    const tools = resolveHostTools(
      { builtInToolIds: [WEB_SEARCH_TOOL_NAME] },
      ctx
    );
    expect(Object.keys(tools ?? {})).toEqual([WEB_SEARCH_TOOL_NAME]);
    expect(typeof tools![WEB_SEARCH_TOOL_NAME].execute).toBe("function");
  });

  it("skips unknown ids instead of throwing", () => {
    const tools = resolveHostTools(
      { builtInToolIds: ["not_a_tool", WEB_SEARCH_TOOL_NAME] },
      ctx
    );
    expect(Object.keys(tools ?? {})).toEqual([WEB_SEARCH_TOOL_NAME]);
  });

  it("returns undefined for undefined / empty ids", () => {
    expect(resolveHostTools({}, ctx)).toBeUndefined();
    expect(resolveHostTools({ builtInToolIds: [] }, ctx)).toBeUndefined();
  });

  it("returns undefined without auth context (local BYOK paths)", () => {
    expect(
      resolveHostTools(
        { builtInToolIds: [WEB_SEARCH_TOOL_NAME, BASH_TOOL_NAME], computer },
        null
      )
    ).toBeUndefined();
  });

  it("returns undefined when every requested id is unknown", () => {
    expect(
      resolveHostTools({ builtInToolIds: ["not_a_tool"] }, ctx)
    ).toBeUndefined();
  });

  it("does not double-prefix a lowercase bearer scheme", () => {
    // RFC 7235 schemes are case-insensitive; "bearer x" must pass through
    // instead of becoming "Bearer bearer x".
    const tools = resolveHostTools(
      { builtInToolIds: [WEB_SEARCH_TOOL_NAME] },
      { authHeader: "bearer token-123", projectId: "project-1" }
    );
    expect(tools).toBeDefined();
  });

  it("resolves with a raw (prefixless) bearer — eval call shape", () => {
    // Eval threads `convexAuthToken` without the "Bearer " prefix; the
    // resolver normalizes, so the same call shape works for both.
    const tools = resolveHostTools(
      { builtInToolIds: [WEB_SEARCH_TOOL_NAME] },
      { authHeader: "raw-token", projectId: "project-1" }
    );
    expect(tools).toBeDefined();
    expect(Object.keys(tools!)).toEqual([WEB_SEARCH_TOOL_NAME]);
  });
});

describe("resolveHostTools — computer-backed bash", () => {
  it("advertises bash when the id is granted AND a computer is attached", () => {
    const tools = resolveHostTools(
      { builtInToolIds: [BASH_TOOL_NAME], computer },
      { ...ctx, requireToolApproval: true }
    );
    expect(Object.keys(tools ?? {})).toEqual([BASH_TOOL_NAME]);
    const bash = tools![BASH_TOOL_NAME] as { needsApproval?: boolean };
    expect(typeof tools![BASH_TOOL_NAME].execute).toBe("function");
    // The host's approval policy reaches the tool.
    expect(bash.needsApproval).toBe(true);
  });

  it("skips bash when the host grants the id but attaches no computer", () => {
    const tools = resolveHostTools(
      { builtInToolIds: [BASH_TOOL_NAME, WEB_SEARCH_TOOL_NAME] },
      ctx
    );
    expect(Object.keys(tools ?? {})).toEqual([WEB_SEARCH_TOOL_NAME]);
  });

  it("advertises bash to guest actors too (cost is contained backend-side)", () => {
    const tools = resolveHostTools(
      { builtInToolIds: [BASH_TOOL_NAME, WEB_SEARCH_TOOL_NAME], computer },
      { ...ctx, isGuest: true }
    );
    expect(Object.keys(tools ?? {})).toContain(BASH_TOOL_NAME);
  });

  it("does NOT advertise bash off the computer alone — the id must be granted", () => {
    const tools = resolveHostTools(
      { builtInToolIds: [WEB_SEARCH_TOOL_NAME], computer },
      ctx
    );
    expect(Object.keys(tools ?? {})).toEqual([WEB_SEARCH_TOOL_NAME]);
  });
});

describe("resolveHostTools — mcpjam workspace tools", () => {
  it("resolves mcpjam_list_servers without a live-ops runner", () => {
    const tools = resolveHostTools(
      { builtInToolIds: ["mcpjam_list_servers"] },
      ctx
    );
    expect(Object.keys(tools ?? {})).toEqual(["mcpjam_list_servers"]);
    expect(typeof tools!["mcpjam_list_servers"].execute).toBe("function");
  });

  it("skips live-op ids without a runner, resolves them with one", () => {
    const without = resolveHostTools(
      { builtInToolIds: ["mcpjam_call_tool", "mcpjam_list_servers"] },
      ctx
    );
    expect(Object.keys(without ?? {})).toEqual(["mcpjam_list_servers"]);

    const withRunner = resolveHostTools(
      { builtInToolIds: [...MCPJAM_TOOL_IDS] },
      { ...ctx, mcpjamLiveOps: stubLiveOps() }
    );
    expect(Object.keys(withRunner ?? {}).sort()).toEqual(
      [...MCPJAM_TOOL_IDS].sort()
    );
  });

  it("does not advertise any mcpjam_* id to guest actors", () => {
    const tools = resolveHostTools(
      { builtInToolIds: [...MCPJAM_TOOL_IDS, WEB_SEARCH_TOOL_NAME] },
      { ...ctx, isGuest: true, mcpjamLiveOps: stubLiveOps() }
    );
    expect(Object.keys(tools ?? {})).toEqual([WEB_SEARCH_TOOL_NAME]);
  });

  it("does not advertise any mcpjam_* id in chatbox sessions", () => {
    const tools = resolveHostTools(
      { builtInToolIds: [...MCPJAM_TOOL_IDS, WEB_SEARCH_TOOL_NAME] },
      { ...ctx, isChatboxSession: true, mcpjamLiveOps: stubLiveOps() }
    );
    expect(Object.keys(tools ?? {})).toEqual([WEB_SEARCH_TOOL_NAME]);
  });

  it("requireToolApproval gates connection-opening ops but never list_servers", () => {
    const tools = resolveHostTools(
      {
        builtInToolIds: [
          "mcpjam_list_servers",
          "mcpjam_call_tool",
          "mcpjam_diagnose_server",
        ],
      },
      { ...ctx, mcpjamLiveOps: stubLiveOps(), requireToolApproval: true }
    );
    const approval = (id: string) =>
      (tools![id] as { needsApproval?: boolean }).needsApproval;
    expect(approval("mcpjam_call_tool")).toBe(true);
    expect(approval("mcpjam_diagnose_server")).toBe(true);
    expect(approval("mcpjam_list_servers")).toBeUndefined();
  });

  it("live ops do not require approval when the host policy is off", () => {
    const tools = resolveHostTools(
      { builtInToolIds: ["mcpjam_call_tool"] },
      { ...ctx, mcpjamLiveOps: stubLiveOps() }
    );
    expect(
      (tools!["mcpjam_call_tool"] as { needsApproval?: boolean }).needsApproval
    ).toBe(false);
  });
});

describe("narrowHostComputer", () => {
  it("accepts the resource shape and preserves workdir", () => {
    expect(narrowHostComputer({ kind: "personal", workdir: "/srv" })).toEqual({
      kind: "personal",
      workdir: "/srv",
    });
  });

  it("tolerates and drops the legacy toolset key", () => {
    expect(narrowHostComputer({ kind: "personal", toolset: "bash" })).toEqual({
      kind: "personal",
    });
  });

  it("rejects non-objects and wrong kinds; empty workdir collapses", () => {
    expect(narrowHostComputer(undefined)).toBeNull();
    expect(narrowHostComputer(null)).toBeNull();
    expect(narrowHostComputer("personal")).toBeNull();
    expect(narrowHostComputer({ kind: "shared" })).toBeNull();
    expect(narrowHostComputer({ kind: "personal", workdir: "   " })).toEqual({
      kind: "personal",
    });
  });
});
