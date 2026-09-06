/**
 * `EvalRunRouteFacts` — the report-only route + mismatch contract.
 *
 * Organised around the ways a route view LIES:
 *
 *   - a retry counted as a different path;
 *   - a subset or an out-of-catalog call labelled "substitution";
 *   - a negative test entering mismatch facts;
 *   - a catalog-not-loaded run inventing in-catalog substitutions;
 *   - a zero denominator rendered as a number;
 *   - an excluded trial leaking into a rate;
 *   - and two shuffles of the same trials producing two documents.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import {
  EVAL_ROUTE_CATALOG_STATES,
  EVAL_ROUTE_TAGS,
  EVAL_RUN_ROUTE_FACTS_SCHEMA_VERSION,
  EVAL_TOOL_CATALOG_MEMBERSHIPS,
  MAX_ROUTES_PER_CASE,
  MAX_ROUTE_TOOL_CALLS,
  NO_TOOL_PATH_KEY,
  ROUTE_FACTS_VERSION,
  PATH_SEPARATOR,
  buildEvalRunRouteFacts,
  buildPathKey,
  classifyRouteTrial,
  collapseImmediateRepeats,
  deriveTrialRoute,
  evalRunRouteFactsSchema,
  evalTrialRate,
  isEvalRouteCatalogState,
  isEvalRouteTag,
  isEvalToolCatalogMembership,
  mismatchFacts,
  readToolName,
  rollupCaseRoutes,
  type RouteFactsCatalog,
  type RouteFactsRunInput,
  type RouteFactsTrialInput,
} from "../src/contract/index.js";

const FIXTURE_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "fixtures",
  "route-facts-fixtures.json"
);

type FixtureRow = Record<string, unknown> & {
  __label: string;
  __why?: string;
};

type RouteFactsFixtures = {
  accept: FixtureRow[];
  reject: FixtureRow[];
  roundTrip: FixtureRow[];
};

function stripAnnotations<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((entry) => stripAnnotations(entry)) as unknown as T;
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(
      value as Record<string, unknown>
    )) {
      if (key.startsWith("__")) continue;
      out[key] = stripAnnotations(entry);
    }
    return out as unknown as T;
  }
  return value;
}

const fixtures = JSON.parse(
  readFileSync(FIXTURE_PATH, "utf8")
) as RouteFactsFixtures;

const call = (name: string) => ({ toolName: name });

const trial = (
  over: Partial<RouteFactsTrialInput> & { trialKey: string }
): RouteFactsTrialInput => ({
  status: "completed",
  result: "failed",
  actualToolCalls: [],
  expectedToolCalls: [],
  caseVariantKey: "case_a\u0000",
  caseKey: "case_a",
  ...over,
});

const run = (over: Partial<RouteFactsRunInput> = {}): RouteFactsRunInput => ({
  runId: "run_1",
  suiteId: "suite_1",
  materializationState: "final",
  now: 1_700_000_000_000,
  ...over,
});

const catalogLoaded = (
  names: readonly string[],
  hash = "hash_1"
): RouteFactsCatalog => ({
  state: "loaded",
  toolNames: names,
  hash,
});

const build = (
  trials: RouteFactsTrialInput[],
  catalog: RouteFactsCatalog = catalogLoaded(["tool_a", "tool_b", "tool_c"]),
  runOver: Partial<RouteFactsRunInput> = {}
) => buildEvalRunRouteFacts({ run: run(runOver), trials, catalog });

const caseOf = (doc: ReturnType<typeof build>, key = "case_a\u0000") =>
  doc.cases.find((row) => row.caseVariantKey === key)!;

// ── vocabularies ─────────────────────────────────────────────────────────────

describe("closed vocabularies", () => {
  test("tags, catalog states and memberships have guards", () => {
    expect(EVAL_ROUTE_TAGS).toEqual(["noToolCalled", "retried", "looping"]);
    expect(isEvalRouteTag("retried")).toBe(true);
    expect(isEvalRouteTag("multi_tool")).toBe(false);
    expect(EVAL_ROUTE_CATALOG_STATES).toEqual(["loaded", "notLoaded"]);
    expect(isEvalRouteCatalogState("notLoaded")).toBe(true);
    expect(isEvalToolCatalogMembership("inCatalog")).toBe(true);
    expect(EVAL_TOOL_CATALOG_MEMBERSHIPS).toHaveLength(3);
  });
});

// ── helpers ──────────────────────────────────────────────────────────────────

describe("readToolName / path helpers", () => {
  test("reads toolName, then tool, then name, and skips empties", () => {
    expect(readToolName({ toolName: "tool_a" })).toBe("tool_a");
    expect(readToolName({ tool: "tool_b" })).toBe("tool_b");
    expect(readToolName({ name: "tool_c" })).toBe("tool_c");
    expect(readToolName({ toolName: "  tool_a  " })).toBe("tool_a");
    expect(readToolName({ toolName: "" })).toBeUndefined();
    expect(readToolName(null)).toBeUndefined();
  });

  test("collapseImmediateRepeats and buildPathKey", () => {
    expect(collapseImmediateRepeats(["tool_a", "tool_a", "tool_b"])).toEqual([
      "tool_a",
      "tool_b",
    ]);
    expect(buildPathKey(["tool_a", "tool_a", "tool_b"])).toBe(
      `tool_a${PATH_SEPARATOR}tool_b`
    );
    expect(buildPathKey([])).toBe(NO_TOOL_PATH_KEY);
  });

  test("retried collapses to the same route; a revisit does not", () => {
    const retried = deriveTrialRoute([
      call("tool_a"),
      call("tool_a"),
      call("tool_b"),
    ]);
    expect(retried.pathKey).toBe(`tool_a${PATH_SEPARATOR}tool_b`);
    expect(retried.tags).toEqual(["retried"]);
    expect(retried.retryCount).toBe(1);

    const revisit = deriveTrialRoute([
      call("tool_a"),
      call("tool_b"),
      call("tool_a"),
    ]);
    expect(revisit.pathKey).toBe(
      `tool_a${PATH_SEPARATOR}tool_b${PATH_SEPARATOR}tool_a`
    );
    expect(revisit.tags).toEqual([]);
  });

  test("looping tags a tool called three times and records loopedOn", () => {
    const looping = deriveTrialRoute([
      call("tool_a"),
      call("tool_a"),
      call("tool_a"),
    ]);
    expect(looping.tags).toEqual(["retried", "looping"]);
    expect(looping.pathKey).toBe("tool_a");
  });

  test("no tool is the sentinel path", () => {
    expect(deriveTrialRoute([]).tags).toEqual(["noToolCalled"]);
    expect(deriveTrialRoute([]).pathKey).toBe(NO_TOOL_PATH_KEY);
  });
});

describe("evalTrialRate — 0/0 is never a number", () => {
  test("a zero denominator is notMeasured", () => {
    expect(evalTrialRate(0, 0)).toMatchObject({
      state: "notMeasured",
      value: null,
      numerator: 0,
      denominator: 0,
    });
  });

  test("value is the exact quotient", () => {
    expect(evalTrialRate(1, 4)).toMatchObject({
      state: "measured",
      value: 0.25,
    });
  });

  test("an impossible rate is refused rather than shipped", () => {
    expect(evalTrialRate(5, 4).state).toBe("notMeasured");
    expect(evalTrialRate(-1, 4).state).toBe("notMeasured");
  });
});

describe("classifyRouteTrial", () => {
  test("maps lifecycle statuses, treats failed as executionFailed, and an unknown status as unfinished", () => {
    expect(classifyRouteTrial({ status: "completed" })).toBeUndefined();
    expect(classifyRouteTrial({ status: "pending" })).toBe("notTerminal");
    expect(classifyRouteTrial({ status: "running" })).toBe("notTerminal");
    expect(classifyRouteTrial({ status: "skipped" })).toBe("skipped");
    expect(classifyRouteTrial({ status: "cancelled" })).toBe("cancelled");
    expect(classifyRouteTrial({ status: "setup_failed" })).toBe("setupFailed");
    expect(classifyRouteTrial({ status: "timed_out" })).toBe("timedOut");
    expect(classifyRouteTrial({ status: "failed" })).toBe("executionFailed");
    expect(classifyRouteTrial({ status: "grading" })).toBe("notTerminal");
  });

  test("evaluator error wins over a completed status", () => {
    expect(
      classifyRouteTrial({ status: "completed", evaluatorErrored: true })
    ).toBe("evaluatorError");
  });
});

// ── semantic matrix ──────────────────────────────────────────────────────────

describe("mismatch facts", () => {
  test("one-to-one in-catalog swap is a substitution", () => {
    const facts = mismatchFacts(
      [
        trial({
          trialKey: "t1",
          expectedToolCalls: [call("tool_a")],
          actualToolCalls: [call("tool_b")],
        }),
      ],
      catalogLoaded(["tool_a", "tool_b"])
    );
    expect(facts).toMatchObject({
      state: "measured",
      substitutions: [{ expected: "tool_a", observed: "tool_b", trials: 1 }],
    });
    if (facts.state !== "measured") throw new Error("expected measured");
    expect(facts.expected).toEqual([
      {
        tool: "tool_a",
        expectedIn: 1,
        notCalledIn: 1,
        notCalledInFailed: 1,
      },
    ]);
    expect(facts.unexpected).toEqual([
      {
        tool: "tool_b",
        calledIn: 1,
        calledInFailed: 1,
        catalog: "inCatalog",
      },
    ]);
  });

  test("a subset route is not a substitution", () => {
    const facts = mismatchFacts(
      [
        trial({
          trialKey: "t1",
          expectedToolCalls: [call("tool_a"), call("tool_b")],
          actualToolCalls: [call("tool_a")],
        }),
      ],
      catalogLoaded(["tool_a", "tool_b"])
    );
    if (facts.state !== "measured") throw new Error("expected measured");
    expect(facts.substitutions).toEqual([]);
    expect(facts.expected.find((row) => row.tool === "tool_b")).toMatchObject({
      notCalledIn: 1,
      expectedIn: 1,
    });
  });

  test("an outside-catalog extra is not a substitution", () => {
    const facts = mismatchFacts(
      [
        trial({
          trialKey: "t1",
          expectedToolCalls: [call("tool_a")],
          actualToolCalls: [call("tool_z")],
        }),
      ],
      catalogLoaded(["tool_a", "tool_b"])
    );
    if (facts.state !== "measured") throw new Error("expected measured");
    expect(facts.substitutions).toEqual([]);
    expect(facts.unexpected[0]).toMatchObject({
      tool: "tool_z",
      catalog: "outsideCatalog",
    });
  });

  test("catalog-not-loaded forbids substitution", () => {
    const facts = mismatchFacts(
      [
        trial({
          trialKey: "t1",
          expectedToolCalls: [call("tool_a")],
          actualToolCalls: [call("tool_b")],
        }),
      ],
      { state: "notLoaded" }
    );
    if (facts.state !== "measured") throw new Error("expected measured");
    expect(facts.substitutions).toEqual([]);
    expect(facts.unexpected[0]?.catalog).toBe("catalogNotLoaded");
  });

  test("negative tests never enter mismatch facts", () => {
    expect(
      mismatchFacts(
        [
          trial({
            trialKey: "t1",
            isNegativeTest: true,
            result: "passed",
            actualToolCalls: [],
            expectedToolCalls: [call("tool_a")],
          }),
        ],
        catalogLoaded(["tool_a"])
      )
    ).toEqual({ state: "excludedNegativeTest" });
  });

  test("wrong-args still counts as called (name-level only)", () => {
    const facts = mismatchFacts(
      [
        trial({
          trialKey: "t1",
          expectedToolCalls: [call("tool_a")],
          actualToolCalls: [{ toolName: "tool_a", arguments: { q: "wrong" } }],
          result: "failed",
        }),
      ],
      catalogLoaded(["tool_a"])
    );
    if (facts.state !== "measured") throw new Error("expected measured");
    expect(facts.expected[0]).toMatchObject({
      notCalledIn: 0,
      expectedIn: 1,
    });
    expect(facts.substitutions).toEqual([]);
  });
});

describe("buildEvalRunRouteFacts", () => {
  test("no-tool and all-pass routes", () => {
    const doc = build([
      trial({
        trialKey: "t1",
        result: "passed",
        actualToolCalls: [call("tool_a"), call("tool_b")],
        expectedToolCalls: [call("tool_a"), call("tool_b")],
      }),
      trial({
        trialKey: "t2",
        actualToolCalls: [],
        expectedToolCalls: [call("tool_a")],
      }),
    ]);
    const row = caseOf(doc);
    expect(row.routes.routes).toEqual([
      { pathKey: NO_TOOL_PATH_KEY, trials: 1, passed: 0, failed: 1 },
      {
        pathKey: `tool_a${PATH_SEPARATOR}tool_b`,
        trials: 1,
        passed: 1,
        failed: 0,
      },
    ]);
    expect(row.routes.tags.noToolCalled).toMatchObject({
      state: "measured",
      numerator: 1,
      denominator: 2,
      value: 0.5,
    });
  });

  test("exclusions by status and evaluator error leave the denominator", () => {
    const doc = build([
      trial({
        trialKey: "ok",
        result: "passed",
        actualToolCalls: [call("tool_a")],
      }),
      trial({ trialKey: "pending", status: "pending" }),
      trial({ trialKey: "cancelled", status: "cancelled" }),
      trial({ trialKey: "failed-status", status: "failed" }),
      trial({ trialKey: "eval", evaluatorErrored: true }),
    ]);
    expect(doc.includedTrials).toBe(1);
    expect(doc.totalTrials).toBe(5);
    expect(doc.exclusions).toEqual({
      notTerminal: 1,
      cancelled: 1,
      executionFailed: 1,
      evaluatorError: 1,
    });
    expect(caseOf(doc).routes.tags.noToolCalled.exclusions).toEqual(
      doc.exclusions
    );
  });

  test("endedWithQuestion is notMeasured until a producer supplies the boolean", () => {
    const unset = build([
      trial({
        trialKey: "t1",
        result: "passed",
        actualToolCalls: [call("tool_a")],
      }),
    ]);
    expect(caseOf(unset).routes.endedWithQuestion.state).toBe("notMeasured");

    const mixed = build([
      trial({
        trialKey: "t1",
        result: "passed",
        actualToolCalls: [call("tool_a")],
        endedWithQuestion: true,
      }),
      trial({
        trialKey: "t2",
        result: "passed",
        actualToolCalls: [call("tool_a")],
        endedWithQuestion: false,
      }),
      trial({
        trialKey: "t3",
        result: "passed",
        actualToolCalls: [call("tool_a")],
      }),
    ]);
    expect(caseOf(mixed).routes.endedWithQuestion).toMatchObject({
      state: "measured",
      numerator: 1,
      denominator: 2,
      value: 0.5,
    });
  });

  test("route fold keeps 24 named routes and aggregates the tail", () => {
    const trials = Array.from({ length: MAX_ROUTES_PER_CASE + 3 }, (_, i) =>
      trial({
        trialKey: `t${i}`,
        actualToolCalls: [call(`tool_${i}`)],
        expectedToolCalls: [call("tool_a")],
      })
    );
    const routes = rollupCaseRoutes(trials);
    expect(routes.routes).toHaveLength(MAX_ROUTES_PER_CASE);
    expect(routes.otherRoutes).toEqual({
      distinctPaths: 3,
      trials: 3,
      passed: 0,
      failed: 3,
    });
  });

  test("negative tests stay in routes and leave mismatch excluded", () => {
    const doc = build([
      trial({
        trialKey: "t1",
        isNegativeTest: true,
        result: "passed",
        actualToolCalls: [],
        expectedToolCalls: [call("tool_a")],
      }),
    ]);
    const row = caseOf(doc);
    expect(row.routes.routes[0]?.pathKey).toBe(NO_TOOL_PATH_KEY);
    expect(row.mismatch).toEqual({ state: "excludedNegativeTest" });
  });

  test("determinism under shuffle", () => {
    const trials: RouteFactsTrialInput[] = [
      trial({
        trialKey: "b",
        caseVariantKey: "case_b\u0000",
        caseKey: "case_b",
        actualToolCalls: [call("tool_b")],
        expectedToolCalls: [call("tool_a")],
      }),
      trial({
        trialKey: "a2",
        actualToolCalls: [call("tool_a"), call("tool_a")],
        expectedToolCalls: [call("tool_a")],
        result: "passed",
      }),
      trial({
        trialKey: "a1",
        actualToolCalls: [call("tool_a")],
        expectedToolCalls: [call("tool_a")],
        result: "passed",
      }),
    ];
    const forward = build(trials);
    const backward = build([...trials].reverse());
    expect(forward).toEqual(backward);
    expect(forward.cases.map((row) => row.caseVariantKey)).toEqual([
      "case_a\u0000",
      "case_b\u0000",
    ]);
  });

  test("loopedOn records the tool a trial looped on", () => {
    const doc = build([
      trial({
        trialKey: "t1",
        actualToolCalls: [call("tool_a"), call("tool_a"), call("tool_a")],
        expectedToolCalls: [call("tool_b")],
      }),
    ]);
    expect(caseOf(doc).routes.loopedOn).toEqual([
      { tool: "tool_a", trials: 1 },
    ]);
    expect(caseOf(doc).routes.tags.looping).toMatchObject({
      numerator: 1,
      denominator: 1,
    });
  });

  test("the produced document satisfies the schema", () => {
    const doc = build([
      trial({
        trialKey: "t1",
        result: "passed",
        actualToolCalls: [call("tool_a")],
        expectedToolCalls: [call("tool_a")],
      }),
    ]);
    expect(doc.schemaVersion).toBe(EVAL_RUN_ROUTE_FACTS_SCHEMA_VERSION);
    expect(doc.routeFactsVersion).toBe(ROUTE_FACTS_VERSION);
    expect(evalRunRouteFactsSchema.safeParse(doc).success).toBe(true);
  });

  test("a persisted row whose otherRoutes predates distinctPaths still parses", () => {
    // The producer that persists rows folds the tail with trial counts only.
    // The builder writes `distinctPaths`; the reader must not refuse a whole
    // document over a count it can say "and more" without.
    const trials = Array.from({ length: MAX_ROUTES_PER_CASE + 2 }, (_, i) =>
      trial({
        trialKey: `t${i}`,
        actualToolCalls: [call(`tool_${i}`)],
        expectedToolCalls: [call("tool_a")],
      })
    );
    const doc = build(trials);
    const folded = caseOf(doc).routes.otherRoutes;
    expect(folded?.distinctPaths).toBe(2);
    const legacy = {
      trials: folded!.trials,
      passed: folded!.passed,
      failed: folded!.failed,
    };
    const payload = {
      ...doc,
      cases: doc.cases.map((row) => ({
        ...row,
        routes: { ...row.routes, otherRoutes: legacy },
      })),
    };
    const parsed = evalRunRouteFactsSchema.safeParse(payload);
    expect(parsed.error?.issues ?? []).toEqual([]);
    expect(parsed.success).toBe(true);
  });
});

// ── fixture cohorts ──────────────────────────────────────────────────────────

describe("fixture cohorts", () => {
  test("every accept row parses", () => {
    for (const row of fixtures.accept) {
      const parsed = evalRunRouteFactsSchema.safeParse(stripAnnotations(row));
      expect(parsed.error?.issues ?? [], row.__label).toEqual([]);
      expect(parsed.success, row.__label).toBe(true);
    }
  });

  test("every reject row is refused", () => {
    for (const row of fixtures.reject) {
      const parsed = evalRunRouteFactsSchema.safeParse(stripAnnotations(row));
      expect(parsed.success, row.__label).toBe(false);
    }
  });

  test("every roundTrip row survives parse unchanged", () => {
    for (const row of fixtures.roundTrip) {
      const payload = stripAnnotations(row);
      const parsed = evalRunRouteFactsSchema.parse(payload);
      expect(parsed).toEqual(payload);
    }
  });
});

describe("route truncation", () => {
  test("a trial past MAX_ROUTE_TOOL_CALLS is marked, and the case counts it", () => {
    const calls = Array.from({ length: MAX_ROUTE_TOOL_CALLS + 1 }, (_, i) =>
      call(i % 2 === 0 ? "tool_a" : "tool_b")
    );
    const route = deriveTrialRoute(calls);
    expect(route.truncated).toBe(true);
    expect(route.toolCallSequence).toHaveLength(MAX_ROUTE_TOOL_CALLS);
    expect(deriveTrialRoute([call("tool_a")]).truncated).toBeUndefined();

    const doc = buildEvalRunRouteFacts({
      run: run(),
      catalog: catalogLoaded(["tool_a", "tool_b"]),
      trials: [
        trial({
          trialKey: "long",
          result: "passed",
          actualToolCalls: calls,
          expectedToolCalls: [call("tool_a")],
        }),
        trial({
          trialKey: "short",
          result: "passed",
          actualToolCalls: [call("tool_a")],
          expectedToolCalls: [call("tool_a")],
        }),
      ],
    });
    expect(doc.cases[0]!.routes.truncatedTrials).toBe(1);
  });
});
