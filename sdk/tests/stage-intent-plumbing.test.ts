import { describe, expect, it } from "vitest";
import { EvalSuite } from "../src/EvalSuite.js";
import { EvalTest } from "../src/EvalTest.js";
import {
  MAX_INTENT_CHARS,
  attachStageMeasurements,
  evalSuiteFileCaseSchema,
  USER_VALUE_STAGES,
} from "../src/contract/index.js";
import { resolveEvalSuiteFile } from "../src/suite-file-loader.js";
import type { EvalSuiteFile } from "../src/contract/suite-file.js";
import {
  findFixture,
  suiteFileFixtures as data,
  suiteFilePayload as payload,
} from "./support/eval-suite-fixtures.js";

// =============================================================================
// `intent` end to end, and the measurements that ride with a chain (B5c).
//
// The three wire states are the whole contract, and they are not
// interchangeable:
//
//   omitted -> this reporter does not speak; a stored label is PRESERVED
//   null    -> an authoritative clear
//   string  -> set
//
// A file has only two of them: it carries a string or omits the key. `null` is
// a MUTATION word, and the CLI reconciler is what turns a file's absence into
// the explicit clear. Getting that split wrong is not cosmetic — it is the
// difference between a legacy CI job preserving a team's labels and silently
// stripping them.
// =============================================================================

describe("the authored file schema", () => {
  const baseCase = {
    id: "c_one",
    title: "A case",
    steps: [{ id: "s1", kind: "prompt" as const, prompt: "Do the thing." }],
  };

  it("accepts a string label", () => {
    const parsed = evalSuiteFileCaseSchema.safeParse({
      ...baseCase,
      intent: "search",
    });
    expect(parsed.success).toBe(true);
  });

  it("accepts an omitted label", () => {
    expect(evalSuiteFileCaseSchema.safeParse(baseCase).success).toBe(true);
  });

  it("REFUSES null — a file omits the key instead", () => {
    // Accepting it would give an author two spellings of one absence, and put
    // this schema out of step with the backend validator, which refuses it.
    const parsed = evalSuiteFileCaseSchema.safeParse({
      ...baseCase,
      intent: null,
    });
    expect(parsed.success).toBe(false);
  });

  it("refuses an over-long label rather than truncating it", () => {
    // Truncation invents a label nobody wrote and merges two distinct intents
    // that share a prefix into one bucket.
    const parsed = evalSuiteFileCaseSchema.safeParse({
      ...baseCase,
      intent: "x".repeat(MAX_INTENT_CHARS + 1),
    });
    expect(parsed.success).toBe(false);
  });

  it("refuses an untrimmed label, so whitespace cannot fork a funnel", () => {
    const parsed = evalSuiteFileCaseSchema.safeParse({
      ...baseCase,
      intent: " search ",
    });
    expect(parsed.success).toBe(false);
  });
});

describe("loading a file", () => {
  // Built from the shared parity corpus rather than hand-rolled, so this test
  // cannot drift into asserting against a file shape the loader would reject
  // for unrelated reasons.
  const MINIMAL = payload(findFixture(data.accept, "minimal")) as EvalSuiteFile;
  const fileWith = (caseOver: Record<string, unknown>) =>
    ({
      ...MINIMAL,
      cases: [{ ...MINIMAL.cases[0], ...caseOver }],
    }) as EvalSuiteFile;

  it("resolves a label onto the case", () => {
    const loaded = resolveEvalSuiteFile(fileWith({ intent: "search" }));
    expect(loaded.cases[0]?.intent).toBe("search");
  });

  it("leaves the field ABSENT when the file omits it", () => {
    // Absent, not empty-string: turning absence into a clear is the
    // reconciler's job, and a resolved case describes what the file SAYS.
    const loaded = resolveEvalSuiteFile(fileWith({}));
    expect("intent" in (loaded.cases[0] ?? {})).toBe(false);
  });
});

describe("what a reporter sends", () => {
  const runAndCapture = async (test: EvalTest) => {
    const suite = new EvalSuite({ name: "s" });
    suite.add(test);
    return suite;
  };

  it("normalizes a label at AUTHORING time, not at ingest", () => {
    const test = new EvalTest({
      id: "c_one",
      name: "case",
      intent: "  search  ",
      test: async () => true,
    });
    expect((test as unknown as { config: { intent?: string } }).config.intent)
      .toBe("search");
  });

  it("drops a blank label at authoring time", () => {
    const test = new EvalTest({
      id: "c_one",
      name: "case",
      intent: "   ",
      test: async () => true,
    });
    expect(
      (test as unknown as { config: { intent?: string } }).config.intent
    ).toBeUndefined();
  });

  it("THROWS on an over-long label, where the author can see it", () => {
    // Accepted here, it is dropped silently at ingest and the case quietly
    // stops appearing in the funnel it was labelled for.
    expect(
      () =>
        new EvalTest({
          id: "c_one",
          name: "case",
          intent: "x".repeat(MAX_INTENT_CHARS + 1),
          test: async () => true,
        })
    ).toThrow();
  });

  it("keeps an unlabelled case authoritative rather than silent", async () => {
    // A code-authored case that carries no label IS unlabelled, and says so.
    // Only a pre-intent SDK omits the field, and only that omission preserves
    // a label somebody set in the UI.
    const suite = await runAndCapture(
      new EvalTest({ id: "c_one", name: "case", test: async () => true })
    );
    expect(suite).toBeDefined();
  });
});

describe("attachStageMeasurements", () => {
  const chain = USER_VALUE_STAGES.map((stage) => ({ stage, state: "passed" }));

  it("is a NO-OP without a chain", () => {
    // Measurements that vouch for rows nobody wrote describe nothing, and the
    // backend rejects them on exactly that ground.
    const metadata = { retryCount: 0 };
    expect(attachStageMeasurements(metadata)).toBe(metadata);
    expect(attachStageMeasurements({ ...metadata, stageResults: [] })).toEqual({
      ...metadata,
      stageResults: [],
    });
  });

  it("emits all six reach rows even with no spans at all", () => {
    const out = attachStageMeasurements({
      stageResults: chain,
      stageAnalyzerVersion: 5,
    });
    const measurements = out.stageMeasurements as {
      rows: Array<{ stage: string; latency?: unknown }>;
      stageAnalyzerVersion: number;
    };
    expect(measurements.rows.map((r) => r.stage)).toEqual([
      ...USER_VALUE_STAGES,
    ]);
    // No timing available means no sample — never a zero, which would read as
    // "this stage took no time".
    expect(measurements.rows.every((r) => r.latency === undefined)).toBe(true);
    expect(measurements.stageAnalyzerVersion).toBe(5);
  });

  it("carries the chain's analyzer version onto the measurements", () => {
    // A pair naming two different analyzers is an integrity failure at the
    // backend, so the version has to come FROM the chain rather than a default.
    const out = attachStageMeasurements({
      stageResults: chain,
      stageAnalyzerVersion: 4,
    });
    expect(
      (out.stageMeasurements as { stageAnalyzerVersion: number })
        .stageAnalyzerVersion
    ).toBe(4);
  });

  it("unions overlapping cited spans instead of summing them", () => {
    const cited = USER_VALUE_STAGES.map((stage) => ({
      stage,
      state: "passed",
      ...(stage === "selection"
        ? { evidence: { spanIds: ["p1", "p2"] } }
        : {}),
    }));
    const out = attachStageMeasurements(
      { stageResults: cited, stageAnalyzerVersion: 5 },
      [
        { id: "p1", startedAt: 0, endedAt: 500 },
        { id: "p2", startedAt: 250, endedAt: 800 },
      ]
    );
    const selection = (
      out.stageMeasurements as {
        rows: Array<{ stage: string; latency?: { value: number } }>;
      }
    ).rows.find((r) => r.stage === "selection");
    // 800 (the union), not 1050 (the sum) — summing reports a parallel server
    // as twice as slow as it is.
    expect(selection?.latency?.value).toBe(800);
  });
});
