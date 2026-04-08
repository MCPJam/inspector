import { describe, it, expect } from "vitest";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import type { InitializationInfo } from "@/state/app-types";
import type { ListToolsResultWithMetadata } from "@/lib/apis/mcp-tools-api";
import type { ServerInspectionSnapshot } from "../types";
import {
  stableStringify,
  normalizeToolSnapshot,
  normalizeInitSnapshot,
  buildSnapshot,
  computeInspectionDiff,
  hasMeaningfulChanges,
} from "../diff-engine";

// ── Helpers ──────────────────────────────────────────────────────────

function makeTool(overrides: Partial<Tool> & { name: string }): Tool {
  return {
    name: overrides.name,
    description: overrides.description,
    inputSchema: overrides.inputSchema ?? { type: "object" as const },
    ...(overrides.annotations ? { annotations: overrides.annotations } : {}),
    ...(overrides._meta ? { _meta: overrides._meta } : {}),
  } as Tool;
}

function makeInit(overrides: Partial<InitializationInfo> = {}): InitializationInfo {
  return {
    protocolVersion: "2025-03-26",
    transport: "streamable-http",
    serverVersion: { name: "test-server", version: "1.0.0" },
    instructions: "You are a helpful assistant.",
    serverCapabilities: { tools: {} },
    ...overrides,
  };
}

function makeToolsResult(
  tools: Tool[],
  toolsMetadata?: Record<string, Record<string, any>>,
): ListToolsResultWithMetadata {
  return { tools, toolsMetadata };
}

function makeSnapshot(
  init: InitializationInfo,
  toolsResult: ListToolsResultWithMetadata,
): ServerInspectionSnapshot {
  return buildSnapshot(init, toolsResult);
}

// ── stableStringify ──────────────────────────────────────────────────

describe("stableStringify", () => {
  it("produces identical output regardless of key order", () => {
    const a = { z: 1, a: 2, m: 3 };
    const b = { a: 2, m: 3, z: 1 };
    expect(stableStringify(a)).toBe(stableStringify(b));
  });

  it("handles nested objects", () => {
    const a = { outer: { z: 1, a: 2 } };
    const b = { outer: { a: 2, z: 1 } };
    expect(stableStringify(a)).toBe(stableStringify(b));
  });

  it("preserves array order", () => {
    const a = [3, 1, 2];
    const b = [1, 2, 3];
    expect(stableStringify(a)).not.toBe(stableStringify(b));
  });

  it("handles null and undefined", () => {
    expect(stableStringify(null)).toBe("null");
    expect(stableStringify(undefined)).toBe(undefined);
  });
});

// ── normalizeToolSnapshot ────────────────────────────────────────────

describe("normalizeToolSnapshot", () => {
  it("extracts relevant fields from a tool", () => {
    const tool = makeTool({
      name: "get_weather",
      description: "Get weather data",
      inputSchema: { type: "object", properties: { city: { type: "string" } } },
    });

    const result = normalizeToolSnapshot(tool);
    expect(result.name).toBe("get_weather");
    expect(result.description).toBe("Get weather data");
    expect(result.inputSchema).toEqual({
      type: "object",
      properties: { city: { type: "string" } },
    });
  });

  it("merges tool._meta when present", () => {
    const tool = makeTool({
      name: "t",
      _meta: { uiHint: "button" },
    });

    const result = normalizeToolSnapshot(tool);
    expect(result.metadata).toEqual({ uiHint: "button" });
  });

  it("uses externalMetadata when tool._meta is absent", () => {
    const tool = makeTool({ name: "t" });
    const result = normalizeToolSnapshot(tool, { uiHint: "panel" });
    expect(result.metadata).toEqual({ uiHint: "panel" });
  });

  it("prefers tool._meta over externalMetadata", () => {
    const tool = makeTool({ name: "t", _meta: { uiHint: "button" } });
    const result = normalizeToolSnapshot(tool, { uiHint: "panel" });
    expect(result.metadata).toEqual({ uiHint: "button" });
  });

  it("omits undefined optional fields", () => {
    const tool = makeTool({ name: "bare" });
    const result = normalizeToolSnapshot(tool);
    expect(result).toEqual({ name: "bare", inputSchema: { type: "object" } });
    expect("metadata" in result).toBe(false);
    expect("annotations" in result).toBe(false);
  });

  it("stabilizes key order in nested objects", () => {
    const tool = makeTool({
      name: "t",
      inputSchema: { type: "object", properties: { z: { type: "string" }, a: { type: "number" } } },
    });
    const json = JSON.stringify(normalizeToolSnapshot(tool));
    // "a" should come before "z" in the stabilized output
    expect(json.indexOf('"a"')).toBeLessThan(json.indexOf('"z"'));
  });
});

// ── normalizeInitSnapshot ────────────────────────────────────────────

describe("normalizeInitSnapshot", () => {
  it("extracts server-facing fields", () => {
    const init = makeInit();
    const result = normalizeInitSnapshot(init);
    expect(result.protocolVersion).toBe("2025-03-26");
    expect(result.transport).toBe("streamable-http");
    expect(result.serverVersion).toEqual({
      name: "test-server",
      version: "1.0.0",
    });
    expect(result.instructions).toBe("You are a helpful assistant.");
    expect(result.serverCapabilities).toEqual({ tools: {} });
  });

  it("excludes clientCapabilities", () => {
    const init = makeInit({
      clientCapabilities: { sampling: {} },
    });
    const result = normalizeInitSnapshot(init);
    expect("clientCapabilities" in result).toBe(false);
  });

  it("omits undefined fields", () => {
    const result = normalizeInitSnapshot({});
    expect(Object.keys(result)).toHaveLength(0);
  });
});

// ── buildSnapshot ────────────────────────────────────────────────────

describe("buildSnapshot", () => {
  it("builds a snapshot with sorted tools", () => {
    const init = makeInit();
    const tools = [
      makeTool({ name: "z_tool" }),
      makeTool({ name: "a_tool" }),
      makeTool({ name: "m_tool" }),
    ];
    const snapshot = buildSnapshot(init, makeToolsResult(tools));
    expect(snapshot.tools.map((t) => t.name)).toEqual([
      "a_tool",
      "m_tool",
      "z_tool",
    ]);
  });

  it("merges toolsMetadata into tool snapshots", () => {
    const tool = makeTool({ name: "my_tool" });
    const metadata = { my_tool: { uiHint: "panel" } };
    const snapshot = buildSnapshot(makeInit(), makeToolsResult([tool], metadata));
    expect(snapshot.tools[0].metadata).toEqual({ uiHint: "panel" });
  });

  it("prefers tool._meta over toolsMetadata", () => {
    const tool = makeTool({ name: "my_tool", _meta: { uiHint: "button" } });
    const metadata = { my_tool: { uiHint: "panel" } };
    const snapshot = buildSnapshot(makeInit(), makeToolsResult([tool], metadata));
    expect(snapshot.tools[0].metadata).toEqual({ uiHint: "button" });
  });

  it("sets capturedAt to a timestamp", () => {
    const snapshot = buildSnapshot(makeInit(), makeToolsResult([]));
    expect(typeof snapshot.capturedAt).toBe("number");
    expect(snapshot.capturedAt).toBeGreaterThan(0);
  });
});

// ── computeInspectionDiff ────────────────────────────────────────────

describe("computeInspectionDiff", () => {
  it("produces empty diff for identical snapshots", () => {
    const s = makeSnapshot(makeInit(), makeToolsResult([makeTool({ name: "t" })]));
    const diff = computeInspectionDiff(s, s);
    expect(diff.initChanges).toHaveLength(0);
    expect(diff.toolChanges).toHaveLength(0);
  });

  // ── Tool diffs ───────────────────────────────────────────────────

  it("detects added tool", () => {
    const prev = makeSnapshot(makeInit(), makeToolsResult([]));
    const current = makeSnapshot(
      makeInit(),
      makeToolsResult([makeTool({ name: "new_tool", description: "New!" })]),
    );
    const diff = computeInspectionDiff(prev, current);
    expect(diff.toolChanges).toHaveLength(1);
    expect(diff.toolChanges[0].type).toBe("added");
    expect(diff.toolChanges[0].name).toBe("new_tool");
    expect(diff.toolChanges[0].after?.description).toBe("New!");
  });

  it("detects removed tool", () => {
    const prev = makeSnapshot(
      makeInit(),
      makeToolsResult([makeTool({ name: "old_tool" })]),
    );
    const current = makeSnapshot(makeInit(), makeToolsResult([]));
    const diff = computeInspectionDiff(prev, current);
    expect(diff.toolChanges).toHaveLength(1);
    expect(diff.toolChanges[0].type).toBe("removed");
    expect(diff.toolChanges[0].name).toBe("old_tool");
  });

  it("detects changed tool description", () => {
    const prev = makeSnapshot(
      makeInit(),
      makeToolsResult([makeTool({ name: "t", description: "old" })]),
    );
    const current = makeSnapshot(
      makeInit(),
      makeToolsResult([makeTool({ name: "t", description: "new" })]),
    );
    const diff = computeInspectionDiff(prev, current);
    expect(diff.toolChanges).toHaveLength(1);
    expect(diff.toolChanges[0].type).toBe("changed");
    expect(diff.toolChanges[0].changedFields).toEqual(["description"]);
  });

  it("detects changed inputSchema", () => {
    const prev = makeSnapshot(
      makeInit(),
      makeToolsResult([
        makeTool({ name: "t", inputSchema: { type: "object", properties: { a: { type: "string" } } } }),
      ]),
    );
    const current = makeSnapshot(
      makeInit(),
      makeToolsResult([
        makeTool({ name: "t", inputSchema: { type: "object", properties: { b: { type: "number" } } } }),
      ]),
    );
    const diff = computeInspectionDiff(prev, current);
    expect(diff.toolChanges).toHaveLength(1);
    expect(diff.toolChanges[0].changedFields).toContain("inputSchema");
  });

  it("detects changed outputSchema", () => {
    const toolA = { ...makeTool({ name: "t" }), outputSchema: { type: "string" } } as unknown as Tool;
    const toolB = { ...makeTool({ name: "t" }), outputSchema: { type: "number" } } as unknown as Tool;
    const prev = makeSnapshot(makeInit(), makeToolsResult([toolA]));
    const current = makeSnapshot(makeInit(), makeToolsResult([toolB]));
    const diff = computeInspectionDiff(prev, current);
    expect(diff.toolChanges[0].changedFields).toContain("outputSchema");
  });

  it("detects changed metadata", () => {
    const prev = makeSnapshot(
      makeInit(),
      makeToolsResult([makeTool({ name: "t", _meta: { v: 1 } })]),
    );
    const current = makeSnapshot(
      makeInit(),
      makeToolsResult([makeTool({ name: "t", _meta: { v: 2 } })]),
    );
    const diff = computeInspectionDiff(prev, current);
    expect(diff.toolChanges[0].changedFields).toContain("metadata");
  });

  it("detects changed annotations", () => {
    const prev = makeSnapshot(
      makeInit(),
      makeToolsResult([
        makeTool({ name: "t", annotations: { readOnlyHint: true } as any }),
      ]),
    );
    const current = makeSnapshot(
      makeInit(),
      makeToolsResult([
        makeTool({ name: "t", annotations: { readOnlyHint: false } as any }),
      ]),
    );
    const diff = computeInspectionDiff(prev, current);
    expect(diff.toolChanges[0].changedFields).toContain("annotations");
  });

  it("detects merged metadata change from toolsMetadata", () => {
    const tool = makeTool({ name: "t" });
    const prev = makeSnapshot(
      makeInit(),
      makeToolsResult([tool], { t: { panel: "old" } }),
    );
    const current = makeSnapshot(
      makeInit(),
      makeToolsResult([tool], { t: { panel: "new" } }),
    );
    const diff = computeInspectionDiff(prev, current);
    expect(diff.toolChanges).toHaveLength(1);
    expect(diff.toolChanges[0].changedFields).toContain("metadata");
  });

  // ── Init diffs ───────────────────────────────────────────────────

  it("detects changed protocolVersion", () => {
    const prev = makeSnapshot(makeInit({ protocolVersion: "2024-11-05" }), makeToolsResult([]));
    const current = makeSnapshot(makeInit({ protocolVersion: "2025-03-26" }), makeToolsResult([]));
    const diff = computeInspectionDiff(prev, current);
    expect(diff.initChanges).toContainEqual({
      field: "protocolVersion",
      before: "2024-11-05",
      after: "2025-03-26",
    });
  });

  it("detects changed transport", () => {
    const prev = makeSnapshot(makeInit({ transport: "stdio" }), makeToolsResult([]));
    const current = makeSnapshot(makeInit({ transport: "streamable-http" }), makeToolsResult([]));
    const diff = computeInspectionDiff(prev, current);
    expect(diff.initChanges).toContainEqual({
      field: "transport",
      before: "stdio",
      after: "streamable-http",
    });
  });

  it("detects changed instructions", () => {
    const prev = makeSnapshot(
      makeInit({ instructions: "Be helpful." }),
      makeToolsResult([]),
    );
    const current = makeSnapshot(
      makeInit({ instructions: "Be concise." }),
      makeToolsResult([]),
    );
    const diff = computeInspectionDiff(prev, current);
    expect(diff.initChanges).toContainEqual({
      field: "instructions",
      before: "Be helpful.",
      after: "Be concise.",
    });
  });

  it("detects changed serverVersion", () => {
    const prev = makeSnapshot(
      makeInit({ serverVersion: { name: "s", version: "1.0.0" } }),
      makeToolsResult([]),
    );
    const current = makeSnapshot(
      makeInit({ serverVersion: { name: "s", version: "2.0.0" } }),
      makeToolsResult([]),
    );
    const diff = computeInspectionDiff(prev, current);
    expect(diff.initChanges.find((c) => c.field === "serverVersion")).toBeTruthy();
  });

  it("detects changed serverCapabilities", () => {
    const prev = makeSnapshot(
      makeInit({ serverCapabilities: { tools: {} } }),
      makeToolsResult([]),
    );
    const current = makeSnapshot(
      makeInit({ serverCapabilities: { tools: {}, prompts: {} } }),
      makeToolsResult([]),
    );
    const diff = computeInspectionDiff(prev, current);
    expect(
      diff.initChanges.find((c) => c.field === "serverCapabilities"),
    ).toBeTruthy();
  });

  // ── Normalization ────────────────────────────────────────────────

  it("ignores key-ordering-only changes", () => {
    const init1 = makeInit({ serverCapabilities: { tools: {}, prompts: {} } });
    const init2 = makeInit({ serverCapabilities: { prompts: {}, tools: {} } });
    const prev = makeSnapshot(init1, makeToolsResult([]));
    const current = makeSnapshot(init2, makeToolsResult([]));
    const diff = computeInspectionDiff(prev, current);
    expect(diff.initChanges).toHaveLength(0);
  });

  it("ignores tool ordering differences", () => {
    const tools1 = [makeTool({ name: "b" }), makeTool({ name: "a" })];
    const tools2 = [makeTool({ name: "a" }), makeTool({ name: "b" })];
    const prev = makeSnapshot(makeInit(), makeToolsResult(tools1));
    const current = makeSnapshot(makeInit(), makeToolsResult(tools2));
    const diff = computeInspectionDiff(prev, current);
    expect(diff.toolChanges).toHaveLength(0);
  });

  // ── clientCapabilities exclusion ─────────────────────────────────

  it("does not report clientCapabilities changes", () => {
    const init1 = makeInit({ clientCapabilities: { sampling: {} } });
    const init2 = makeInit({ clientCapabilities: { sampling: {}, roots: {} } });
    const prev = makeSnapshot(init1, makeToolsResult([]));
    const current = makeSnapshot(init2, makeToolsResult([]));
    const diff = computeInspectionDiff(prev, current);
    expect(
      diff.initChanges.find((c) => c.field === "clientCapabilities"),
    ).toBeUndefined();
    expect(diff.initChanges).toHaveLength(0);
  });

  // ── Aggregate changes ────────────────────────────────────────────

  it("handles multiple simultaneous changes", () => {
    const prev = makeSnapshot(
      makeInit({ protocolVersion: "1.0", instructions: "old" }),
      makeToolsResult([
        makeTool({ name: "keep", description: "same" }),
        makeTool({ name: "remove_me" }),
        makeTool({ name: "change_me", description: "old" }),
      ]),
    );
    const current = makeSnapshot(
      makeInit({ protocolVersion: "2.0", instructions: "new" }),
      makeToolsResult([
        makeTool({ name: "keep", description: "same" }),
        makeTool({ name: "add_me", description: "new tool" }),
        makeTool({ name: "change_me", description: "new" }),
      ]),
    );
    const diff = computeInspectionDiff(prev, current);
    expect(diff.initChanges).toHaveLength(2);
    expect(diff.toolChanges.filter((c) => c.type === "added")).toHaveLength(1);
    expect(diff.toolChanges.filter((c) => c.type === "removed")).toHaveLength(1);
    expect(diff.toolChanges.filter((c) => c.type === "changed")).toHaveLength(1);
  });

  // ── Sort order ───────────────────────────────────────────────────

  it("sorts tool changes: added, changed, removed, alpha within groups", () => {
    const prev = makeSnapshot(
      makeInit(),
      makeToolsResult([
        makeTool({ name: "remove_b" }),
        makeTool({ name: "remove_a" }),
        makeTool({ name: "change_b", description: "old" }),
        makeTool({ name: "change_a", description: "old" }),
      ]),
    );
    const current = makeSnapshot(
      makeInit(),
      makeToolsResult([
        makeTool({ name: "add_b" }),
        makeTool({ name: "add_a" }),
        makeTool({ name: "change_b", description: "new" }),
        makeTool({ name: "change_a", description: "new" }),
      ]),
    );
    const diff = computeInspectionDiff(prev, current);
    const names = diff.toolChanges.map((c) => `${c.type}:${c.name}`);
    expect(names).toEqual([
      "added:add_a",
      "added:add_b",
      "changed:change_a",
      "changed:change_b",
      "removed:remove_a",
      "removed:remove_b",
    ]);
  });
});

// ── hasMeaningfulChanges ─────────────────────────────────────────────

describe("hasMeaningfulChanges", () => {
  it("returns false for empty diff", () => {
    expect(
      hasMeaningfulChanges({
        initChanges: [],
        toolChanges: [],
        computedAt: Date.now(),
      }),
    ).toBe(false);
  });

  it("returns true when init changes exist", () => {
    expect(
      hasMeaningfulChanges({
        initChanges: [{ field: "protocolVersion", before: "1", after: "2" }],
        toolChanges: [],
        computedAt: Date.now(),
      }),
    ).toBe(true);
  });

  it("returns true when tool changes exist", () => {
    expect(
      hasMeaningfulChanges({
        initChanges: [],
        toolChanges: [{ type: "added", name: "t" }],
        computedAt: Date.now(),
      }),
    ).toBe(true);
  });
});
