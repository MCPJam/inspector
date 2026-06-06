import {
  filterAppOnlyTools,
  applyVisibilityPolicyAndCountSignals,
  isAppOnlyTool,
  type HostExecutionPolicy,
  type ToolMetadataSource,
} from "../src/host-config/internal";

function mockSource(
  metaByServer: Record<string, Record<string, Record<string, unknown>>>,
): ToolMetadataSource {
  return {
    getAllToolsMetadata(serverId: string) {
      return metaByServer[serverId] ?? {};
    },
  };
}

describe("isAppOnlyTool", () => {
  it("returns false for undefined meta", () => {
    expect(isAppOnlyTool(undefined)).toBe(false);
  });

  it("returns false when visibility is missing", () => {
    expect(isAppOnlyTool({})).toBe(false);
    expect(isAppOnlyTool({ ui: {} })).toBe(false);
  });

  it("returns false when visibility is not an array", () => {
    expect(isAppOnlyTool({ ui: { visibility: "app" } })).toBe(false);
  });

  it("returns true only when visibility is exactly ['app']", () => {
    expect(isAppOnlyTool({ ui: { visibility: ["app"] } })).toBe(true);
    expect(isAppOnlyTool({ ui: { visibility: ["model"] } })).toBe(false);
    expect(isAppOnlyTool({ ui: { visibility: ["model", "app"] } })).toBe(false);
    expect(isAppOnlyTool({ ui: { visibility: ["app", "model"] } })).toBe(false);
    expect(isAppOnlyTool({ ui: { visibility: [] } })).toBe(false);
  });
});

describe("filterAppOnlyTools", () => {
  it("drops tools whose source metadata is visibility=['app']", () => {
    const tools: Record<string, unknown> = {
      model_tool: { _serverId: "srv" },
      app_tool: { _serverId: "srv" },
      both_tool: { _serverId: "srv" },
    };
    const source = mockSource({
      srv: {
        model_tool: { ui: { visibility: ["model"] } },
        app_tool: { ui: { visibility: ["app"] } },
        both_tool: { ui: { visibility: ["model", "app"] } },
      },
    });

    filterAppOnlyTools(tools, source);

    expect(Object.keys(tools).sort()).toEqual(["both_tool", "model_tool"]);
  });

  it("preserves tools without _serverId (non-MCP origin)", () => {
    const tools: Record<string, unknown> = {
      skill_tool: { description: "skill tool, no _serverId" },
      app_tool: { _serverId: "srv" },
    };
    const source = mockSource({
      srv: { app_tool: { ui: { visibility: ["app"] } } },
    });

    filterAppOnlyTools(tools, source);

    expect(Object.keys(tools).sort()).toEqual(["skill_tool"]);
  });

  it("caches metadata per server (only one lookup per server)", () => {
    let lookups = 0;
    const source: ToolMetadataSource = {
      getAllToolsMetadata(serverId: string) {
        lookups += 1;
        return serverId === "srv"
          ? {
              a: { ui: { visibility: ["app"] } },
              b: { ui: { visibility: ["app"] } },
              c: { ui: { visibility: ["app"] } },
            }
          : {};
      },
    };
    const tools: Record<string, unknown> = {
      a: { _serverId: "srv" },
      b: { _serverId: "srv" },
      c: { _serverId: "srv" },
    };

    filterAppOnlyTools(tools, source);

    expect(lookups).toBe(1);
    expect(Object.keys(tools)).toEqual([]);
  });

  it("leaves tools alone whose metadata is missing", () => {
    const tools: Record<string, unknown> = {
      mystery: { _serverId: "srv" },
    };
    const source = mockSource({ srv: {} });

    filterAppOnlyTools(tools, source);

    expect(Object.keys(tools)).toEqual(["mystery"]);
  });
});

describe("applyVisibilityPolicyAndCountSignals", () => {
  const basePolicy: HostExecutionPolicy = {
    requireToolApproval: false,
    respectToolVisibility: undefined,
    progressiveDiscoveryEnabled: false,
    hostStyle: undefined,
    namedHostId: undefined,
  };

  function makeTools() {
    return {
      model_tool: { _serverId: "srv" },
      app_tool: { _serverId: "srv" },
      both_tool: { _serverId: "srv" },
    } as Record<string, unknown>;
  }

  function makeSource() {
    return mockSource({
      srv: {
        model_tool: { ui: { visibility: ["model"] } },
        app_tool: { ui: { visibility: ["app"] } },
        both_tool: { ui: { visibility: ["model", "app"] } },
      },
    });
  }

  it("applies the filter when respectToolVisibility is undefined (spec default)", () => {
    const tools = makeTools();
    const signals = applyVisibilityPolicyAndCountSignals(
      tools,
      makeSource(),
      basePolicy,
    );
    expect(Object.keys(tools).sort()).toEqual(["both_tool", "model_tool"]);
    expect(signals.toolsTotalBefore).toBe(3);
    expect(signals.toolsExposed).toBe(2);
    expect(signals.toolsDroppedVisibility).toBe(1);
  });

  it("applies the filter when respectToolVisibility is true", () => {
    const tools = makeTools();
    const signals = applyVisibilityPolicyAndCountSignals(tools, makeSource(), {
      ...basePolicy,
      respectToolVisibility: true,
    });
    expect(Object.keys(tools).sort()).toEqual(["both_tool", "model_tool"]);
    expect(signals.toolsDroppedVisibility).toBe(1);
  });

  it("skips the filter when respectToolVisibility is false (opt-out)", () => {
    const tools = makeTools();
    const signals = applyVisibilityPolicyAndCountSignals(tools, makeSource(), {
      ...basePolicy,
      respectToolVisibility: false,
    });
    expect(Object.keys(tools).sort()).toEqual([
      "app_tool",
      "both_tool",
      "model_tool",
    ]);
    expect(signals.toolsTotalBefore).toBe(3);
    expect(signals.toolsExposed).toBe(3);
    expect(signals.toolsDroppedVisibility).toBe(0);
  });

  // Stage 4: the private raw-`Tool[]` conversion in `sdk/src/HostRunner.ts:90`
  // drops app-only tools unconditionally — before this function runs. We
  // can't recover a tool that path already dropped, so a passing test here
  // would be misleading. Stage 4 single-gates the filter (rename
  // `HostRunner` → `HostRunner`, route both `Tool[]` and `AiSdkTool` paths
  // through `applyVisibilityPolicyAndCountSignals`) and converts this skip
  // into a real assertion.
  // eslint-disable-next-line vitest/no-disabled-tests
  it.skip(
    "preserves raw Tool[] app-only when respectToolVisibility=false — fix at HostRunner.ts:90 (Stage 4)",
    () => {
      // TODO(Stage 4): mock raw Tool[] input + assert post-filter preservation.
    },
  );
});
