import { describe, expect, test } from "vitest";
import { evaluatePredicates } from "../src/predicates/evaluate.js";
import {
  predicateSchema,
  type Predicate,
  type IterationTranscript,
  type TranscriptToolDeclaration,
} from "../src/predicates/types.js";
import { deriveStageResults } from "../src/contract/stage-derivation.js";
import { buildIterationTranscript } from "../src/predicates/transcript.js";

const good: TranscriptToolDeclaration = {
  serverKey: "one",
  name: "search",
  description: "Search the workspace for matching documents",
  inputSchema: {
    type: "object",
    properties: { query: { type: "string", description: "Search text" } },
  },
  outputSchema: { type: "object" },
  annotations: { readOnlyHint: true, destructiveHint: false },
};
const rules: Predicate[] = [
  { type: "toolDescriptionsPresent", minLength: 20 },
  {
    type: "toolAnnotationsPresent",
    require: ["readOnlyHint", "destructiveHint"],
  },
  { type: "toolNamesUnique" },
  { type: "noDeprecatedToolExposed", role: "advisory" },
  { type: "toolInputSchemasWellFormed" },
  { type: "toolOutputSchemasPresent" },
];
const transcript = (
  tools: TranscriptToolDeclaration[] = [good],
  capture: "complete" | "partial" | "absent" = "complete"
): IterationTranscript => ({
  toolCalls: [],
  toolDeclarations: tools,
  capture: {
    toolInventory: "absent",
    toolResults: "absent",
    toolCallTimings: "absent",
    toolDeclarations: capture,
  },
});

describe("discovery assertions", () => {
  test.each(rules)(
    "$type passes complete declarations and errors on missing evidence",
    (rule) => {
      expect(predicateSchema.safeParse(rule).success).toBe(true);
      expect(evaluatePredicates(transcript(), [rule])[0].passed).toBe(true);
      expect(
        evaluatePredicates(transcript([], "partial"), [rule])[0].status
      ).toBe("error");
      expect(evaluatePredicates({ toolCalls: [] }, [rule])[0].status).toBe(
        "error"
      );
      expect(evaluatePredicates(transcript([]), [rule])[0].reason).toContain(
        "no tools advertised"
      );
    }
  );
  test("fully observed missing/invalid declarations fail rather than error", () => {
    const bad = {
      serverKey: "one",
      name: "search",
      description: "Deprecated",
      inputSchema: { type: "array" },
    };
    const results = evaluatePredicates(transcript([bad, bad]), rules);
    expect(
      results.every((result) => !result.passed && result.status !== "error")
    ).toBe(true);
  });
  test("names are unique within a server, not across separately identified servers", () => {
    expect(
      evaluatePredicates(transcript([good, { ...good, serverKey: "two" }]), [
        rules[2],
      ])[0].passed
    ).toBe(true);
    expect(
      evaluatePredicates(transcript([good, good]), [rules[2]])[0].passed
    ).toBe(false);
  });
  test("a supplied array does not itself prove complete capture", () => {
    const built = buildIterationTranscript({
      toolCalls: [],
      toolDeclarations: [good],
    });
    expect(evaluatePredicates(built, [rules[0]])[0].status).toBe("error");
  });
  test("deprecation remains an observation even when applied to exposed tools", () => {
    expect(
      predicateSchema.safeParse({ type: "noDeprecatedToolExposed" }).success
    ).toBe(false);
    expect(
      predicateSchema.safeParse({
        type: "noDeprecatedToolExposed",
        role: "gating",
      }).success
    ).toBe(false);
  });
});

describe("discovery stage routing", () => {
  function stages(
    role: "gating" | "advisory",
    status?: "error",
    setup: "ok" | "failed" = "ok",
    attribution: "theirs" | "ours" | "unknown" = "theirs"
  ) {
    return deriveStageResults({
      authored: {
        mode: "model_driven",
        assertionCount: 1,
        expectsToolCall: true,
      },
      iteration: { status: "completed" },
      evidence: {
        setupSignals: {
          connection: { outcome: "ok" },
          discovery: { outcome: setup, attribution },
        },
        toolSignals: { toolsTotalBefore: 1 },
        predicateResults: [
          {
            predicate: { type: "toolDescriptionsPresent", role },
            passed: false,
            reason: "Missing description",
            ...(status ? { status } : {}),
          },
        ],
      },
    }).stageResults;
  }
  test("a gating failure outranks successful tools/list and positive inventory", () => {
    const rows = stages("gating");
    expect(rows.find((row) => row.stage === "discovery")).toMatchObject({
      state: "failed",
      reason: "predicateFailed",
    });
    expect(rows.find((row) => row.stage === "userValue")?.reason).not.toBe(
      "predicateFailed"
    );
  });
  test("advisory failures and errors leave successful discovery observed", () => {
    for (const rows of [stages("advisory"), stages("gating", "error")]) {
      expect(rows.find((row) => row.stage === "discovery")).toMatchObject({
        state: "passed",
        reason: "observed",
      });
    }
  });
  test("setup failure attribution takes precedence", () => {
    expect(
      stages("gating", undefined, "failed").find(
        (row) => row.stage === "discovery"
      )
    ).toMatchObject({ state: "failed", reason: "toolsListFailed" });
    for (const attribution of ["ours", "unknown"] as const) {
      expect(
        stages("gating", undefined, "failed", attribution).find(
          (row) => row.stage === "discovery"
        )?.state
      ).toBe("notMeasured");
    }
  });
});
