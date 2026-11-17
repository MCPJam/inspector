import { describe, expect, test } from "vitest";
import { evaluatePredicates } from "../src/predicates/evaluate.js";
import {
  allGatingScorersPassed,
  buildEvaluationConfigSnapshot,
  deriveStageResults,
  predicateScoreDefinition,
  resolveScoreDefinition,
  scoreResultFromPredicateResult,
} from "../src/contract/index.js";
import {
  predicateSchema,
  type IterationTranscript,
  type Predicate,
  type TranscriptToolDeclaration,
  type TranscriptToolResult,
} from "../src/predicates/types.js";

const declared: Predicate = {
  type: "toolResultMatchesSchema",
  schema: "declared",
};

const getOrder: TranscriptToolDeclaration = {
  serverKey: "shop",
  name: "get_order",
  inputSchema: { type: "object" },
  outputSchema: {
    type: "object",
    properties: { status: { type: "string" }, total: { type: "number" } },
    required: ["status", "total"],
  },
};
const search: TranscriptToolDeclaration = {
  serverKey: "shop",
  name: "search",
  inputSchema: { type: "object" },
};

const result = (
  toolName: string,
  patch: Partial<TranscriptToolResult> = {}
): TranscriptToolResult => ({
  toolName,
  size: { bytes: 10, basis: "model_visible_output", complete: true },
  ...patch,
});

const transcript = (
  results: TranscriptToolResult[],
  declarations: TranscriptToolDeclaration[] | null = [getOrder, search]
): IterationTranscript => ({
  toolCalls: [],
  toolResults: results,
  ...(declarations ? { toolDeclarations: declarations } : {}),
  capture: {
    toolInventory: "absent",
    toolResults: "complete",
    toolCallTimings: "absent",
    toolDeclarations: declarations ? "complete" : "absent",
  },
});

const run = (t: IterationTranscript) => evaluatePredicates(t, [declared])[0];

describe("toolResultMatchesSchema with the declared schema", () => {
  test("is a valid predicate, and other strings are not", () => {
    expect(predicateSchema.safeParse(declared).success).toBe(true);
    expect(
      predicateSchema.safeParse({
        type: "toolResultMatchesSchema",
        schema: "object",
      }).success
    ).toBe(false);
  });

  test("passes structured results that match their tool's schema", () => {
    const verdict = run(
      transcript([
        result("get_order", {
          structuredContent: { status: "confirmed", total: 42 },
        }),
        result("search", { text: "free text" }),
      ])
    );
    expect(verdict.passed).toBe(true);
    expect(verdict.reason).toContain("1 result(s) match");
  });

  test("fails a result that breaks its declared schema", () => {
    const verdict = run(
      transcript([
        result("get_order", { structuredContent: { status: "confirmed" } }),
      ])
    );
    expect(verdict.passed).toBe(false);
    expect(verdict.status).toBeUndefined();
    expect(verdict.reason).toContain('"get_order"');
  });

  test("fails a tool with an output schema that returns no structuredContent", () => {
    const verdict = run(
      transcript([
        result("get_order", { text: '{"status":"confirmed","total":42}' }),
      ])
    );
    expect(verdict.passed).toBe(false);
    expect(verdict.reason).toContain("returned no structuredContent");
  });

  test("skips error results and tools without an output schema", () => {
    const verdict = run(
      transcript([
        result("get_order", { isError: true, text: "order not found" }),
        result("search", { structuredContent: { anything: true } }),
      ])
    );
    expect(verdict.passed).toBe(true);
    expect(verdict.reason).toContain("nothing to validate");
  });

  test("does not apply when no tool declares an output schema", () => {
    const verdict = run(
      transcript([result("search", { structuredContent: {} })], [search])
    );
    expect(verdict.status).toBe("not_applicable");
    expect(verdict.passed).toBe(true);
    expect(verdict.reason).toContain("no tool declares an output schema");
  });

  test("cannot pass on a partial or missing result capture", () => {
    const matching = result("get_order", {
      structuredContent: { status: "confirmed", total: 42 },
    });
    const partial = transcript([matching]);
    partial.capture = { ...partial.capture!, toolResults: "partial" };
    expect(run(partial).status).toBe("error");
    const absent = transcript([]);
    absent.capture = { ...absent.capture!, toolResults: "absent" };
    absent.toolCalls = [{ toolName: "get_order", arguments: {} }];
    expect(run(absent).status).toBe("error");
  });

  test("still fails on a partial capture when a seen result breaks the schema", () => {
    const partial = transcript([
      result("get_order", { structuredContent: { status: "confirmed" } }),
    ]);
    partial.capture = { ...partial.capture!, toolResults: "partial" };
    const verdict = run(partial);
    expect(verdict.passed).toBe(false);
    expect(verdict.status).toBeUndefined();
  });

  test("is an evidence error when the declarations were not captured", () => {
    const verdict = run(
      transcript([result("get_order", { structuredContent: {} })], null)
    );
    expect(verdict.status).toBe("error");
  });
});

describe("a not-applicable declared-schema row downstream", () => {
  const notApplicable = run(
    transcript([result("search", { structuredContent: {} })], [search])
  );

  test("projects as a not-applicable score row that neither passes nor gates", () => {
    const definition = resolveScoreDefinition(
      predicateScoreDefinition(declared, { ordinal: 0 })
    );
    const score = scoreResultFromPredicateResult(definition, notApplicable);
    expect(score.status).toBe("not_applicable");
    expect(score).not.toHaveProperty("value");
    const config = buildEvaluationConfigSnapshot([definition]);
    expect(allGatingScorersPassed([score], config).passed).toBe(true);
  });

  test("is dropped from stage evidence instead of passing the stage", () => {
    const { stageResults } = deriveStageResults({
      authored: { mode: "model", toolExpectation: "open", assertionCount: 1 },
      evidence: {
        predicateResults: [notApplicable],
        traceLacksSpanChannel: true,
      },
      iteration: { status: "completed" },
    });
    const stateOf = (rows: typeof stageResults) =>
      rows.find((row) => row.stage === "response")?.state;
    const passing = deriveStageResults({
      authored: { mode: "model", toolExpectation: "open", assertionCount: 1 },
      evidence: {
        predicateResults: [{ ...notApplicable, status: undefined }],
        traceLacksSpanChannel: true,
      },
      iteration: { status: "completed" },
    }).stageResults;
    expect(stateOf(passing)).toBe("passed");
    expect(stateOf(stageResults)).not.toBe("passed");
  });
});
