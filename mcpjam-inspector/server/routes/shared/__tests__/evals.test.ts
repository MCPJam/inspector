import { describe, expect, it } from "vitest";
import type { MCPClientManager } from "@mcpjam/sdk";
import {
  MAX_TOTAL_LLM_CALLS,
  RunEvalsRequestSchema,
  RunTestCaseRequestSchema,
  assertSuiteRunWithinCap,
  assertBareRerunCasesRunnable,
  buildCapEntriesFromPersistedCases,
  buildUpsertCaseKey,
  probeIdentityKey,
  assertTestCaseRunWithinCap,
  buildManagerKeyToDisplayNameMap,
  filterAndRemapReplayConfigs,
  remapSnapshotServerIdsForAttachment,
} from "../evals";
import { WebRouteError } from "../../web/errors";
import { SERVER_TOOL_SNAPSHOT_VERSION } from "../../../utils/export-helpers";

function buildSuiteRequest(overrides?: {
  testCount?: number;
  runs?: number;
}): unknown {
  const testCount = overrides?.testCount ?? 1;
  const runs = overrides?.runs ?? 1;
  return {
    suiteName: "S",
    projectId: "p_1",
    serverIds: ["srv_1"],
    convexAuthToken: "tok",
    tests: Array.from({ length: testCount }, (_, i) => ({
      title: `t${i}`,
      query: "q",
      runs,
      model: "claude-3",
      provider: "anthropic",
      expectedToolCalls: [],
    })),
  };
}

function buildTestCaseRequest(runs?: number): unknown {
  return {
    testCaseId: "tc_1",
    model: "claude-3",
    provider: "anthropic",
    serverIds: ["srv_1"],
    convexAuthToken: "tok",
    ...(runs === undefined ? {} : { testCaseOverrides: { runs } }),
  };
}

describe("RunEvalsRequestSchema runs cap", () => {
  it("accepts runs up to 10", () => {
    const result = RunEvalsRequestSchema.safeParse(
      buildSuiteRequest({ runs: 10 }),
    );
    expect(result.success).toBe(true);
  });

  it("rejects runs above 10 at the Zod layer", () => {
    const result = RunEvalsRequestSchema.safeParse(
      buildSuiteRequest({ runs: 11 }),
    );
    expect(result.success).toBe(false);
  });

  it("rejects non-positive runs", () => {
    const result = RunEvalsRequestSchema.safeParse(
      buildSuiteRequest({ runs: 0 }),
    );
    expect(result.success).toBe(false);
  });

  it("accepts iterationOverride between 1 and 10", () => {
    const base = buildSuiteRequest() as Record<string, unknown>;
    expect(
      RunEvalsRequestSchema.safeParse({ ...base, iterationOverride: 1 }).success,
    ).toBe(true);
    expect(
      RunEvalsRequestSchema.safeParse({ ...base, iterationOverride: 10 }).success,
    ).toBe(true);
  });

  it("rejects iterationOverride outside [1, 10]", () => {
    const base = buildSuiteRequest() as Record<string, unknown>;
    expect(
      RunEvalsRequestSchema.safeParse({ ...base, iterationOverride: 0 }).success,
    ).toBe(false);
    expect(
      RunEvalsRequestSchema.safeParse({ ...base, iterationOverride: 11 }).success,
    ).toBe(false);
  });
});

describe("RunEvalsRequestSchema widget_probe invariant", () => {
  const baseTest = {
    title: "t",
    query: "",
    runs: 1,
    model: "widget-probe",
    provider: "none",
    expectedToolCalls: [],
  };
  const probeConfig = {
    serverId: "srv-1",
    serverName: "server-1",
    toolName: "show_map",
    arguments: {},
  };
  const withTests = (tests: unknown[]) => ({
    ...(buildSuiteRequest() as Record<string, unknown>),
    tests,
  });

  it("accepts a widget_probe row carrying probeConfig", () => {
    const result = RunEvalsRequestSchema.safeParse(
      withTests([{ ...baseTest, caseType: "widget_probe", probeConfig }]),
    );
    expect(result.success).toBe(true);
  });

  it("rejects a widget_probe row without probeConfig (cap-bypass guard)", () => {
    // Cap math exempts rows by caseType alone while the runner only forks
    // off the LLM path when probeConfig is also present — without this
    // rejection the row would run as a cap-exempt LLM case.
    const result = RunEvalsRequestSchema.safeParse(
      withTests([
        { ...baseTest, model: "claude-3", provider: "anthropic", caseType: "widget_probe" },
      ]),
    );
    expect(result.success).toBe(false);
  });

  it("rejects stray probeConfig on a prompt row", () => {
    const result = RunEvalsRequestSchema.safeParse(
      withTests([
        { ...baseTest, model: "claude-3", provider: "anthropic", query: "q", probeConfig },
      ]),
    );
    expect(result.success).toBe(false);
  });
});

describe("RunTestCaseRequestSchema runs cap", () => {
  it("accepts testCaseOverrides.runs up to 10", () => {
    const result = RunTestCaseRequestSchema.safeParse(buildTestCaseRequest(10));
    expect(result.success).toBe(true);
  });

  it("rejects testCaseOverrides.runs above 10", () => {
    const result = RunTestCaseRequestSchema.safeParse(buildTestCaseRequest(11));
    expect(result.success).toBe(false);
  });

  it("allows omitted testCaseOverrides (single-run default)", () => {
    const result = RunTestCaseRequestSchema.safeParse(buildTestCaseRequest());
    expect(result.success).toBe(true);
  });
});

describe("assertSuiteRunWithinCap", () => {
  it("passes when total LLM calls is within the cap", () => {
    const req = RunEvalsRequestSchema.parse(
      buildSuiteRequest({ testCount: 10, runs: 10 }),
    );
    expect(() => assertSuiteRunWithinCap(req)).not.toThrow();
  });

  it(`rejects when total exceeds ${MAX_TOTAL_LLM_CALLS}`, () => {
    const req = RunEvalsRequestSchema.parse(
      buildSuiteRequest({ testCount: 10, runs: 10 }),
    );
    try {
      assertSuiteRunWithinCap(req, 4); // 10 × 10 × 4 = 400 > 300
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(WebRouteError);
      expect((err as WebRouteError).status).toBe(400);
      expect((err as WebRouteError).details?.cap).toBe(MAX_TOTAL_LLM_CALLS);
      expect((err as WebRouteError).details?.totalCalls).toBe(400);
    }
  });

  it(`accepts exactly ${MAX_TOTAL_LLM_CALLS}`, () => {
    const req = RunEvalsRequestSchema.parse(
      buildSuiteRequest({ testCount: 10, runs: 10 }),
    );
    expect(() => assertSuiteRunWithinCap(req, 3)).not.toThrow();
  });

  it("uses iterationOverride for cap math instead of per-test runs", () => {
    // 31 cases × runs=1 each is well under the cap, but with
    // iterationOverride=10 the actual call count is 310 — must trip the cap.
    const base = buildSuiteRequest({ testCount: 31, runs: 1 }) as Record<
      string,
      unknown
    >;
    const req = RunEvalsRequestSchema.parse({
      ...base,
      iterationOverride: 10,
    });
    try {
      assertSuiteRunWithinCap(req);
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(WebRouteError);
      expect((err as WebRouteError).details?.totalCalls).toBe(310);
    }
  });

  it("multiplies promptTurns when counting LLM calls", () => {
    // 151 multi-turn cases × runs=1 × 3 turns each = 453 LLM calls — would
    // bypass the cap if only `runs` was summed.
    const base = buildSuiteRequest({ testCount: 151, runs: 1 }) as {
      tests: Array<Record<string, unknown>>;
    } & Record<string, unknown>;
    const makeTurn = (id: string) => ({
      id,
      prompt: "p",
      expectedToolCalls: [],
    });
    base.tests = base.tests.map((t) => ({
      ...t,
      promptTurns: [makeTurn("a"), makeTurn("b"), makeTurn("c")],
    }));
    const req = RunEvalsRequestSchema.parse(base);
    try {
      assertSuiteRunWithinCap(req);
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(WebRouteError);
      expect((err as WebRouteError).details?.totalCalls).toBe(453);
    }
  });
});

describe("assertTestCaseRunWithinCap", () => {
  it("passes for default (1 call)", () => {
    const req = RunTestCaseRequestSchema.parse(buildTestCaseRequest());
    expect(() => assertTestCaseRunWithinCap(req)).not.toThrow();
  });

  it("rejects beyond cap when a config count multiplier pushes it over", () => {
    const req = RunTestCaseRequestSchema.parse(buildTestCaseRequest(10));
    // 10 iterations × 31 configs > 300
    expect(() => assertTestCaseRunWithinCap(req, 31)).toThrowError(
      WebRouteError,
    );
  });

  it("counts persisted promptTurns when no override is sent", () => {
    // runs=10 override, no promptTurns override, persisted case has 31
    // turns → 310 LLM calls, must trip the cap. Without passing
    // `resolved.promptTurnsLength` the guard would see 10 × 1 = 10.
    const req = RunTestCaseRequestSchema.parse(buildTestCaseRequest(10));
    try {
      assertTestCaseRunWithinCap(req, 1, { promptTurnsLength: 31 });
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(WebRouteError);
      expect((err as WebRouteError).details?.totalCalls).toBe(310);
    }
  });

  it("override promptTurns wins over persisted count", () => {
    const base = buildTestCaseRequest(10) as Record<string, unknown>;
    const req = RunTestCaseRequestSchema.parse({
      ...base,
      testCaseOverrides: {
        ...(base.testCaseOverrides as Record<string, unknown>),
        promptTurns: [
          { id: "a", prompt: "p", expectedToolCalls: [] },
          { id: "b", prompt: "p", expectedToolCalls: [] },
        ],
      },
    });
    // 10 × 2 = 20, well within cap — persisted 999 turns are ignored.
    expect(() =>
      assertTestCaseRunWithinCap(req, 1, { promptTurnsLength: 999 }),
    ).not.toThrow();
  });
});

function makeManagerStub(serverIds: string[]): MCPClientManager {
  return { listServers: () => serverIds } as unknown as MCPClientManager;
}

describe("buildUpsertCaseKey (probe/prompt dedupe identity)", () => {
  const probe = (overrides?: {
    title?: string;
    serverId?: string;
    toolName?: string;
  }) => ({
    title: overrides?.title ?? "Render check",
    query: "",
    caseType: "widget_probe" as const,
    probeConfig: {
      serverId: overrides?.serverId ?? "srv-1",
      serverName: "server-1",
      toolName: overrides?.toolName ?? "show_map",
      arguments: {},
    },
  });

  it("keeps the historical title+query key for prompt rows", () => {
    expect(
      buildUpsertCaseKey({ title: "Case A", query: "do the thing" }),
    ).toBe("Case A-do the thing");
  });

  it("merges the per-model fan-out rows of one prompt case", () => {
    expect(buildUpsertCaseKey({ title: "Case A", query: "q" })).toBe(
      buildUpsertCaseKey({ title: "Case A", query: "q" }),
    );
  });

  it("never collides a probe with a prompt row sharing title and empty query", () => {
    expect(buildUpsertCaseKey(probe())).not.toBe(
      buildUpsertCaseKey({ title: "Render check", query: "" }),
    );
  });

  it("keeps same-titled probes of different tools distinct", () => {
    expect(buildUpsertCaseKey(probe({ toolName: "show_map" }))).not.toBe(
      buildUpsertCaseKey(probe({ toolName: "show_weather" })),
    );
  });

  it("keeps same-titled probes of different servers distinct", () => {
    expect(buildUpsertCaseKey(probe({ serverId: "srv-1" }))).not.toBe(
      buildUpsertCaseKey(probe({ serverId: "srv-2" })),
    );
  });

  it("treats the same probe identity as one case", () => {
    expect(buildUpsertCaseKey(probe())).toBe(buildUpsertCaseKey(probe()));
  });

  it("a crafted title cannot forge another probe's identity", () => {
    // Title embedding the other probe's tail must not collide thanks to
    // the NUL separator.
    const forged = probeIdentityKey({
      title: "Render check srv-1 show_map",
      probeConfig: { serverId: "", serverName: "", toolName: "" } as any,
    });
    expect(forged).not.toBe(probeIdentityKey(probe()));
  });
});

describe("buildManagerKeyToDisplayNameMap", () => {
  it("maps each manager key to its parallel display name", () => {
    const manager = makeManagerStub(["p170sbx_convex_id"]);
    const map = buildManagerKeyToDisplayNameMap(
      manager,
      ["p170sbx_convex_id"],
      ["Excalidraw (App)"],
    );
    expect(map.get("p170sbx_convex_id")).toBe("Excalidraw (App)");
  });

  it("returns an empty map when serverNames is absent or length-mismatched", () => {
    const manager = makeManagerStub(["srv_1", "srv_2"]);
    expect(
      buildManagerKeyToDisplayNameMap(manager, ["srv_1", "srv_2"], undefined)
        .size,
    ).toBe(0);
    expect(
      buildManagerKeyToDisplayNameMap(manager, ["srv_1", "srv_2"], ["A"]).size,
    ).toBe(0);
  });

  it("falls back to case-insensitive manager key match", () => {
    const manager = makeManagerStub(["Excalidraw"]);
    const map = buildManagerKeyToDisplayNameMap(
      manager,
      ["EXCALIDRAW"],
      ["Excalidraw (App)"],
    );
    expect(map.get("Excalidraw")).toBe("Excalidraw (App)");
  });

  it("skips entries whose manager key is not currently connected", () => {
    const manager = makeManagerStub(["srv_present"]);
    const map = buildManagerKeyToDisplayNameMap(
      manager,
      ["srv_present", "srv_disconnected"],
      ["Present", "Missing"],
    );
    expect(map.size).toBe(1);
    expect(map.get("srv_present")).toBe("Present");
  });
});

describe("remapSnapshotServerIdsForAttachment", () => {
  const snapshot = {
    version: SERVER_TOOL_SNAPSHOT_VERSION,
    capturedAt: 1_700_000_000_000,
    servers: [
      { serverId: "manager-key-1", tools: [] },
      { serverId: "manager-key-2", tools: [] },
    ],
  };

  it("rewrites snapshot.serverId from manager key to display name", () => {
    const remapped = remapSnapshotServerIdsForAttachment(
      snapshot,
      new Map([
        ["manager-key-1", "Excalidraw (App)"],
        ["manager-key-2", "Notion"],
      ]),
    );
    expect(remapped.servers.map((s) => s.serverId)).toEqual([
      "Excalidraw (App)",
      "Notion",
    ]);
  });

  it("is a no-op when the map is empty (standalone path)", () => {
    const remapped = remapSnapshotServerIdsForAttachment(snapshot, new Map());
    expect(remapped).toBe(snapshot);
  });

  it("leaves unmapped servers untouched", () => {
    const remapped = remapSnapshotServerIdsForAttachment(
      snapshot,
      new Map([["manager-key-1", "Excalidraw (App)"]]),
    );
    expect(remapped.servers.map((s) => s.serverId)).toEqual([
      "Excalidraw (App)",
      "manager-key-2",
    ]);
  });
});

describe("filterAndRemapReplayConfigs", () => {
  it("filters unrelated servers and remaps stored server ids", () => {
    expect(
      filterAndRemapReplayConfigs(
        [
          {
            serverId: "srv_asana",
            url: "https://asana.example/mcp",
            accessToken: "at_123",
          },
          {
            serverId: "srv_github",
            url: "https://github.example/mcp",
            accessToken: "at_456",
          },
        ],
        ["srv_asana"],
        ["asana"],
      ),
    ).toEqual([
      {
        serverId: "asana",
        url: "https://asana.example/mcp",
        accessToken: "at_123",
      },
    ]);
  });
});

describe("buildCapEntriesFromPersistedCases (bare suite reruns)", () => {
  it("fans out one cap entry per case x model with runs and prompt turns", () => {
    const entries = buildCapEntriesFromPersistedCases([
      {
        title: "Multi-model",
        runs: 3,
        models: [
          { model: "a", provider: "p1" },
          { model: "b", provider: "p2" },
        ],
        promptTurns: [
          { id: "t1", prompt: "one", expectedToolCalls: [] },
          { id: "t2", prompt: "two", expectedToolCalls: [] },
        ],
      },
    ]);
    expect(entries).toHaveLength(2);
    expect(entries[0].runs).toBe(3);
    expect(entries[0].promptTurns).toHaveLength(2);
    // 2 models x 3 runs x 2 turns = 12 LLM calls
    expect(() =>
      assertSuiteRunWithinCap({ tests: entries } as never),
    ).not.toThrow();
  });

  it("counts model-less prompt cases once (suite-default substitution)", () => {
    const entries = buildCapEntriesFromPersistedCases([
      { title: "No models", runs: 2, models: [] },
    ]);
    expect(entries).toHaveLength(1);
    expect(entries[0].runs).toBe(2);
  });

  it("marks widget probes so the cap reducer excludes them", () => {
    const entries = buildCapEntriesFromPersistedCases([
      { title: "Probe", runs: 10, caseType: "widget_probe" },
    ]);
    expect(entries).toHaveLength(1);
    expect(entries[0].caseType).toBe("widget_probe");
    expect(() =>
      assertSuiteRunWithinCap({ tests: entries } as never),
    ).not.toThrow();
  });

  it("a persisted suite over the cap is rejected (the scheduled-run gap)", () => {
    // 31 cases x 1 model x 10 runs x 1 turn = 310 > 300
    const cases = Array.from({ length: 31 }, (_, i) => ({
      title: `case-${i}`,
      runs: 10,
      models: [{ model: "m", provider: "p" }],
    }));
    const entries = buildCapEntriesFromPersistedCases(cases);
    expect(() =>
      assertSuiteRunWithinCap({ tests: entries } as never),
    ).toThrow(WebRouteError);
  });
});

describe("assertBareRerunCasesRunnable (bare suite reruns)", () => {
  it("accepts cases with per-case models", () => {
    expect(() =>
      assertBareRerunCasesRunnable([
        { title: "A", models: [{ model: "m", provider: "p" }] },
      ]),
    ).not.toThrow();
  });

  it("accepts a legacy model/provider case (no models array)", () => {
    expect(() =>
      assertBareRerunCasesRunnable([
        { title: "Legacy", model: "m", provider: "p" },
      ]),
    ).not.toThrow();
  });

  it("accepts widget probes (no model expected)", () => {
    expect(() =>
      assertBareRerunCasesRunnable([
        { title: "Probe", caseType: "widget_probe" },
      ]),
    ).not.toThrow();
  });

  it("accepts null / empty case lists", () => {
    expect(() => assertBareRerunCasesRunnable(null)).not.toThrow();
    expect(() => assertBareRerunCasesRunnable([])).not.toThrow();
  });

  it("rejects a model-less prompt case (would be silently dropped)", () => {
    expect(() =>
      assertBareRerunCasesRunnable([
        { title: "Default-only", models: [] },
      ]),
    ).toThrow(WebRouteError);
  });

  it("rejects a partial suite and names every offending case", () => {
    let captured: WebRouteError | undefined;
    try {
      assertBareRerunCasesRunnable([
        { title: "Runs", models: [{ model: "m", provider: "p" }] },
        { title: "Default-only-1", models: [] },
        { title: "Default-only-2" },
      ]);
    } catch (error) {
      captured = error as WebRouteError;
    }
    expect(captured).toBeInstanceOf(WebRouteError);
    expect(captured!.message).toContain("Default-only-1");
    expect(captured!.message).toContain("Default-only-2");
    expect(captured!.message).not.toContain("Runs");
    expect(captured!.details?.unrunnableCases).toEqual([
      "Default-only-1",
      "Default-only-2",
    ]);
  });

  it("labels an untitled offending case rather than dropping it from the message", () => {
    expect(() =>
      assertBareRerunCasesRunnable([{ models: [] }]),
    ).toThrow(/\(untitled\)/);
  });
});
