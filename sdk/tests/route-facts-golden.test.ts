/**
 * The golden fixture — the conformance target for the backend materializer.
 *
 * Convex functions cannot import `@mcpjam/sdk`, so `buildEvalRunRouteFacts`
 * cannot be the code that writes the hosted row. This file is what keeps
 * "hand-written" from drifting into "different". Regenerate deliberately
 * with `UPDATE_ROUTE_FACTS_GOLDEN=1 vitest run tests/route-facts-golden`.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import {
  NO_TOOL_PATH_KEY,
  PATH_SEPARATOR,
  buildEvalRunRouteFacts,
  evalRunRouteFactsSchema,
  type RouteFactsInput,
  type RouteFactsTrialInput,
} from "../src/contract/index.js";

const GOLDEN_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "fixtures",
  "route-facts-golden.json"
);

const call = (name: string) => ({ toolName: name });

const completed = (
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

/**
 * One scenario that exercises every counting rule the backend mirror
 * must reproduce: substitution, subset, outside-catalog, no-tool,
 * negative excluded from mismatch, looping, retried collapse,
 * exclusions, evaluator error, endedWithQuestion both ways.
 *
 * Prod shape counts (122/85/93/32/22) stay in comments, never in
 * customer tool names.
 */
const INPUT: RouteFactsInput = {
  run: {
    runId: "run_golden",
    suiteId: "suite_golden",
    runGroupId: "group_golden",
    configRevision: "cfg_golden",
    runCompletedAt: 1_700_000_100_000,
    sourceMaxUpdatedAt: 1_700_000_090_000,
    materializationState: "final",
    now: 1_700_000_200_000,
    createdAt: 1_700_000_150_000,
  },
  catalog: {
    state: "loaded",
    toolNames: ["tool_a", "tool_b", "tool_c"],
    hash: "hash_golden",
  },
  trials: [
    // One-to-one in-catalog substitution.
    completed({
      trialKey: "i1",
      expectedToolCalls: [call("tool_a")],
      actualToolCalls: [call("tool_b")],
    }),
    // Subset: expected two, called one. Not a substitution.
    completed({
      trialKey: "i2",
      expectedToolCalls: [call("tool_a"), call("tool_b")],
      actualToolCalls: [call("tool_a")],
    }),
    // Outside catalog extra.
    completed({
      trialKey: "i3",
      expectedToolCalls: [call("tool_a")],
      actualToolCalls: [call("tool_z")],
    }),
    // Called nothing.
    completed({
      trialKey: "i4",
      expectedToolCalls: [call("tool_a")],
      actualToolCalls: [],
    }),
    // Negative test: routes yes, mismatch no.
    completed({
      trialKey: "i5",
      isNegativeTest: true,
      result: "passed",
      expectedToolCalls: [call("tool_a")],
      actualToolCalls: [],
    }),
    // Retried collapse: tool_a,tool_a,tool_b → tool_a→tool_b. Passed.
    completed({
      trialKey: "i6",
      result: "passed",
      expectedToolCalls: [call("tool_a"), call("tool_b")],
      actualToolCalls: [call("tool_a"), call("tool_a"), call("tool_b")],
      endedWithQuestion: false,
    }),
    // Looping on tool_a. Two expected names so this is a subset, not a
    // one-to-one substitution.
    completed({
      trialKey: "i7",
      expectedToolCalls: [call("tool_a"), call("tool_b")],
      actualToolCalls: [call("tool_a"), call("tool_a"), call("tool_a")],
      endedWithQuestion: true,
    }),
    // All-pass sibling case.
    completed({
      trialKey: "i8",
      caseVariantKey: "case_b\u0000",
      caseKey: "case_b",
      result: "passed",
      expectedToolCalls: [call("tool_a"), call("tool_b")],
      actualToolCalls: [call("tool_a"), call("tool_b")],
    }),
    // Exclusions.
    {
      trialKey: "i9",
      status: "cancelled",
      actualToolCalls: [],
      expectedToolCalls: [],
      caseVariantKey: "case_a\u0000",
      caseKey: "case_a",
    },
    {
      trialKey: "i10",
      status: "failed",
      actualToolCalls: [call("tool_a")],
      expectedToolCalls: [call("tool_a")],
      caseVariantKey: "case_a\u0000",
      caseKey: "case_a",
    },
    {
      trialKey: "i11",
      status: "completed",
      evaluatorErrored: true,
      actualToolCalls: [],
      expectedToolCalls: [call("tool_a")],
      caseVariantKey: "case_a\u0000",
      caseKey: "case_a",
    },
  ],
};

describe("golden fixture", () => {
  const actual = buildEvalRunRouteFacts(INPUT);

  test("the fixture is a VALID row", () => {
    const parsed = evalRunRouteFactsSchema.safeParse(actual);
    expect(parsed.error?.issues ?? []).toEqual([]);
  });

  test("matches the committed fixture byte for byte", () => {
    const serialized = `${JSON.stringify(actual, null, 2)}\n`;
    if (process.env.UPDATE_ROUTE_FACTS_GOLDEN === "1") {
      writeFileSync(GOLDEN_PATH, serialized);
    }
    expect(serialized).toBe(readFileSync(GOLDEN_PATH, "utf8"));
  });

  test("the scenario actually exercises what it claims to", () => {
    expect(actual.includedTrials).toBe(8);
    expect(actual.totalTrials).toBe(11);
    expect(actual.exclusions).toEqual({
      cancelled: 1,
      executionFailed: 1,
      evaluatorError: 1,
    });

    const caseA = actual.cases.find((row) => row.caseKey === "case_a")!;
    const caseB = actual.cases.find((row) => row.caseKey === "case_b")!;
    expect(caseA.mismatch.state).toBe("measured");
    if (caseA.mismatch.state !== "measured") throw new Error("measured");
    expect(caseA.mismatch.substitutions).toEqual([
      { expected: "tool_a", observed: "tool_b", trials: 1 },
    ]);
    expect(
      caseA.mismatch.unexpected.find((row) => row.tool === "tool_z")?.catalog
    ).toBe("outsideCatalog");
    expect(caseA.routes.routes.some((row) => row.pathKey === NO_TOOL_PATH_KEY)).toBe(
      true
    );
    expect(
      caseA.routes.routes.some(
        (row) => row.pathKey === `tool_a${PATH_SEPARATOR}tool_b`
      )
    ).toBe(true);
    expect(caseA.routes.loopedOn).toEqual([{ tool: "tool_a", trials: 1 }]);
    expect(caseA.routes.endedWithQuestion).toMatchObject({
      state: "measured",
      numerator: 1,
      denominator: 2,
    });
    expect(caseB.mismatch.state).toBe("measured");
    if (caseB.mismatch.state !== "measured") throw new Error("measured");
    expect(caseB.mismatch.substitutions).toEqual([]);
    expect(caseB.routes.routes[0]).toMatchObject({
      pathKey: `tool_a${PATH_SEPARATOR}tool_b`,
      passed: 1,
    });
  });
});
