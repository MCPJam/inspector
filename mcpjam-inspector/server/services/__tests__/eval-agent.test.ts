import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { generateTestCases } from "../eval-agent";
import type { ServerToolSnapshot } from "../../utils/export-helpers";

/**
 * The generation adapter reads BOTH shapes.
 *
 * The Wave-0 branch lands before the backend starts producing it (W0.3c): a
 * consumer that already accepts both is what makes that a non-breaking change,
 * and what lets either side roll back while both are deployed. The legacy
 * branch is removed in W0.3d, and these legacy cases go with it.
 */
const SNAPSHOT = { version: 1, servers: [] } as unknown as ServerToolSnapshot;

function respondWith(tests: unknown[]) {
  return vi.fn(async () => ({
    ok: true,
    json: async () => ({ ok: true, tests }),
  })) as unknown as typeof fetch;
}

const LEGACY_CASE = {
  title: "lists the files",
  query: "List the files.",
  runs: 3,
  expectedToolCalls: [{ toolName: "list_files", arguments: { path: "." } }],
  scenario: "browsing",
  expectedOutput: "a file listing",
  isNegativeTest: false,
};

/** The same authored intent, in the Wave-0 shape. */
const WAVE0_CASE = {
  shapeVersion: "wave0" as const,
  title: "lists the files",
  steps: [
    { id: "s1", kind: "prompt", prompt: "List the files." },
    {
      id: "s2",
      kind: "assert",
      assertion: {
        type: "toolCalledWith",
        toolName: "list_files",
        args: { args: { path: "." } },
      },
    },
  ],
  repetitions: 3,
  scenario: "browsing",
  expectedOutput: "a file listing",
  isNegativeTest: false,
};

async function generate(tests: unknown[]) {
  vi.stubGlobal("fetch", respondWith(tests));
  return generateTestCases(SNAPSHOT, "https://convex.test", "tok");
}

describe("generateTestCases: dual-shape reader", () => {
  beforeEach(() => vi.unstubAllGlobals());
  afterEach(() => vi.unstubAllGlobals());

  it("reads the legacy shape (no shapeVersion) unchanged", async () => {
    const [testCase] = await generate([LEGACY_CASE]);
    expect(testCase).toMatchObject({
      title: "lists the files",
      query: "List the files.",
      runs: 3,
      expectedToolCalls: [{ toolName: "list_files", arguments: { path: "." } }],
      scenario: "browsing",
      expectedOutput: "a file listing",
      isNegativeTest: false,
    });
    // The legacy shape carries no steps; the persist loop synthesizes them.
    expect(testCase.steps).toBeUndefined();
  });

  it("reads the Wave-0 shape, keeping the authored steps as the source of truth", async () => {
    const [testCase] = await generate([WAVE0_CASE]);
    expect(testCase.steps).toHaveLength(2);
    expect(testCase.steps?.[0]).toMatchObject({
      kind: "prompt",
      prompt: "List the files.",
    });
    // `repetitions` is the Wave-0 name for what the case row stores as `runs`.
    expect(testCase.runs).toBe(3);
  });

  it("derives the same legacy display fields from a Wave-0 case", async () => {
    const [legacy] = await generate([LEGACY_CASE]);
    const [wave0] = await generate([WAVE0_CASE]);
    // Equivalent authored intent must persist equivalently: the two shapes
    // describe one case, so the columns a case row stores must not depend on
    // which contract the backend happened to answer with.
    expect(wave0.query).toBe(legacy.query);
    expect(wave0.expectedToolCalls).toEqual(legacy.expectedToolCalls);
    expect(wave0.title).toBe(legacy.title);
    expect(wave0.runs).toBe(legacy.runs);
    expect(wave0.scenario).toBe(legacy.scenario);
    expect(wave0.expectedOutput).toBe(legacy.expectedOutput);
    expect(wave0.isNegativeTest).toBe(legacy.isNegativeTest);
  });

  it("reads a mixed batch, adapting each case by its own shapeVersion", async () => {
    const cases = await generate([
      LEGACY_CASE,
      { ...WAVE0_CASE, title: "wave0 case" },
    ]);
    expect(cases).toHaveLength(2);
    expect(cases[0].steps).toBeUndefined();
    expect(cases[1].steps).toHaveLength(2);
    expect(cases[1].title).toBe("wave0 case");
  });

  it("defaults a Wave-0 case's optional fields rather than emitting undefined", async () => {
    const [testCase] = await generate([
      {
        shapeVersion: "wave0",
        title: "bare",
        steps: [{ id: "s1", kind: "prompt", prompt: "hi" }],
      },
    ]);
    expect(testCase.runs).toBe(1);
    expect(testCase.scenario).toBe("");
    expect(testCase.expectedOutput).toBe("");
    expect(testCase.isNegativeTest).toBe(false);
  });

  it("carries a Wave-0 negative case through as negative", async () => {
    const [testCase] = await generate([
      {
        shapeVersion: "wave0",
        title: "asks something unanswerable",
        steps: [{ id: "s1", kind: "prompt", prompt: "What is my password?" }],
        isNegativeTest: true,
      },
    ]);
    expect(testCase.isNegativeTest).toBe(true);
    expect(testCase.expectedToolCalls).toEqual([]);
  });

  it.each([
    ["null steps", null],
    ["an empty array", []],
    ["entries that all fail normalization", [{ nonsense: true }]],
  ])(
    "rejects a Wave-0 case whose steps normalize to nothing: %s",
    async (_label, steps) => {
      // The legacy fields cannot stand in — they are derived FROM the steps — so
      // a stepless Wave-0 case would persist as one that can never execute.
      await expect(
        generate([{ shapeVersion: "wave0", title: "bare", steps }])
      ).rejects.toThrow(/no usable steps/);
    }
  );

  it("still fails loudly on a response that is not a generation result", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({ ok: false, error: "quota exhausted" }),
      })) as unknown as typeof fetch
    );
    await expect(
      generateTestCases(SNAPSHOT, "https://convex.test", "tok")
    ).rejects.toThrow(/quota exhausted/);
  });
});
