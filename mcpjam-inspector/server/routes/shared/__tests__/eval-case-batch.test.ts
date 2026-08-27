import { describe, expect, it, vi } from "vitest";
import { isOpaqueId } from "@mcpjam/sdk/contract";
import {
  MAX_CASES_PER_BATCH,
  chunkCases,
  createEvalCasesInBatches,
  partialResultOf,
  withMintedCaseIds,
  type EvalCaseBatchItem,
} from "../eval-case-batch";
import { authorEvalSuite } from "../evals";
import { deriveItemIdempotencyKey } from "../../../utils/idempotency";

/**
 * A convex client that records its mutations and answers `createTestCases`
 * with the real reply shape. `plan` decides each item's fate by title, so a
 * test can commit some items and fail others inside ONE batch — the partial
 * outcome this whole path exists to carry.
 */
function fakeConvexClient(
  plan: {
    failTitles?: Record<string, string>;
    replayTitles?: Record<string, { testCaseId: string; caseId: string }>;
    throwOnBatch?: Error;
    /** Reject only this chunk (0-based), so earlier chunks stay committed. */
    throwOnChunk?: number;
  } = {}
) {
  const calls: Array<{ name: string; args: any }> = [];
  let chunkIndex = -1;
  const mutation = vi.fn(async (name: string, args: any) => {
    calls.push({ name, args });
    if (name === "testSuites:createTestSuite") return { _id: "suite_new" };
    if (name === "testSuites:createTestCases") {
      chunkIndex += 1;
      if (plan.throwOnBatch) throw plan.throwOnBatch;
      if (plan.throwOnChunk === chunkIndex) throw new Error("Not authorized");
      const committed: any[] = [];
      const failed: any[] = [];
      (args.cases ?? []).forEach((item: any, index: number) => {
        const failure = plan.failTitles?.[item.title];
        if (failure) {
          failed.push({
            index,
            title: item.title,
            code: "INVALID_CASE",
            message: failure,
          });
          return;
        }
        const replay = plan.replayTitles?.[item.title];
        committed.push({
          index,
          title: item.title,
          testCaseId: replay?.testCaseId ?? `case_${index}`,
          caseId: replay?.caseId ?? item.caseId,
          replayed: Boolean(replay),
        });
      });
      return {
        caseUpsert: { committed, failed },
        duplicatePolicy: {
          requestedPolicy: args.duplicatePolicy,
          effectivePolicy: args.duplicatePolicy ?? "block",
          coerced: false,
        },
        warnings: [],
      };
    }
    return null;
  });
  return { client: { mutation } as any, calls, mutation };
}

function buildTest(title: string) {
  return {
    title,
    query: `q-${title}`,
    runs: 1,
    model: "claude-sonnet-4-5",
    provider: "anthropic",
    expectedToolCalls: [],
    steps: [{ id: `${title}-s0`, kind: "prompt", prompt: `q-${title}` }],
  };
}

function authorArgs(overrides: Record<string, unknown>) {
  return {
    resolvedServerIds: ["srv_1"],
    persistedServerRefs: ["srv_1"],
    serverNames: ["S"],
    projectId: "p_1",
    suiteId: null,
    suiteName: "S",
    suiteDescription: undefined,
    passCriteria: undefined,
    suiteRerun: undefined,
    refreshSnapshot: undefined,
    ...overrides,
  } as any;
}

describe("chunkCases", () => {
  it("splits at the platform cap so an oversized write is never attempted", () => {
    const items = Array.from(
      { length: MAX_CASES_PER_BATCH * 2 + 1 },
      (_, i) => i
    );
    const chunks = chunkCases(items);
    expect(chunks).toHaveLength(3);
    expect(chunks[0]).toHaveLength(MAX_CASES_PER_BATCH);
    expect(chunks[1]).toHaveLength(MAX_CASES_PER_BATCH);
    expect(chunks[2]).toHaveLength(1);
    // Nothing is dropped or duplicated by the split.
    expect(chunks.flat()).toEqual(items);
  });

  it("returns no chunks for no items, so an empty write never calls the platform", () => {
    expect(chunkCases([])).toEqual([]);
  });
});

describe("withMintedCaseIds", () => {
  it("mints a usable declared id for a case that arrives without one", () => {
    const [minted] = withMintedCaseIds<EvalCaseBatchItem>([{ title: "a" }]);
    expect(isOpaqueId(minted.caseId)).toBe(true);
  });

  it("keeps a caller's id rather than overwriting the identity it chose", () => {
    const [kept] = withMintedCaseIds<EvalCaseBatchItem>([
      { title: "a", caseId: "c_mine" },
    ]);
    expect(kept.caseId).toBe("c_mine");
  });

  it("mints a DISTINCT id per case", () => {
    const items = withMintedCaseIds<EvalCaseBatchItem>([
      { title: "a" },
      { title: "b" },
    ]);
    expect(items[0].caseId).not.toBe(items[1].caseId);
  });
});

describe("createEvalCasesInBatches", () => {
  it("writes one mutation per chunk and reports indices against the ORIGINAL list", async () => {
    const { client, calls } = fakeConvexClient({
      failTitles: { "case-149": "bad steps" },
    });
    const cases = Array.from({ length: MAX_CASES_PER_BATCH + 51 }, (_, i) => ({
      title: `case-${i}`,
    }));

    const result = await createEvalCasesInBatches(client, {
      suiteId: "suite_1",
      cases,
    });

    const batchCalls = calls.filter(
      (c) => c.name === "testSuites:createTestCases"
    );
    expect(batchCalls).toHaveLength(2);
    expect(result.committed).toHaveLength(cases.length - 1);
    // 149 lands in the SECOND chunk at local index 49. Reporting that local
    // index would name case-49 — a different case the caller did send, which
    // is worse than an out-of-range one: it looks correct.
    expect(result.failed).toEqual([
      expect.objectContaining({ index: 149, title: "case-149" }),
    ]);
    expect(result.committed.at(-1)).toMatchObject({
      index: cases.length - 1,
      title: `case-${cases.length - 1}`,
    });
  });

  it("forwards the duplicate policy and its override reason, and returns the audit", async () => {
    const { client, calls } = fakeConvexClient();
    const result = await createEvalCasesInBatches(client, {
      suiteId: "suite_1",
      cases: [{ title: "a" }],
      duplicatePolicy: "create_anyway",
      overrideReason: "porting a fixture verbatim",
    });
    expect(calls[0].args).toMatchObject({
      duplicatePolicy: "create_anyway",
      overrideReason: "porting a fixture verbatim",
    });
    expect(result.duplicatePolicy.effectivePolicy).toBe("create_anyway");
  });

  it("never calls the platform for an empty list", async () => {
    const { client, mutation } = fakeConvexClient();
    const result = await createEvalCasesInBatches(client, {
      suiteId: "suite_1",
      cases: [],
    });
    expect(mutation).not.toHaveBeenCalled();
    expect(result.committed).toEqual([]);
    // The default the platform WOULD have applied — not a third answer.
    expect(result.duplicatePolicy.effectivePolicy).toBe("block");
  });

  it("propagates a whole-call rejection instead of filing it against every item", async () => {
    const { client } = fakeConvexClient({
      throwOnBatch: new Error("Not authorized"),
    });
    await expect(
      createEvalCasesInBatches(client, {
        suiteId: "suite_1",
        cases: [{ title: "a" }, { title: "b" }],
      })
    ).rejects.toThrow("Not authorized");
  });

  it("reports the STORED declared id on a replay, not the one just minted", async () => {
    const { client } = fakeConvexClient({
      replayTitles: { a: { testCaseId: "case_first", caseId: "c_first" } },
    });
    const result = await createEvalCasesInBatches(client, {
      suiteId: "suite_1",
      cases: [{ title: "a", caseId: "c_second" }],
    });
    // The id the first attempt authored wins. Reporting the fresh proposal
    // would name a case that was never written.
    expect(result.committed[0]).toMatchObject({
      index: 0,
      testCaseId: "case_first",
      caseId: "c_first",
      replayed: true,
    });
  });

  it("carries what earlier chunks committed on a later chunk's rejection", async () => {
    const { client } = fakeConvexClient({ throwOnChunk: 1 });
    const cases = Array.from({ length: MAX_CASES_PER_BATCH + 5 }, (_, i) => ({
      title: `case-${i}`,
    }));
    let thrown: unknown;
    try {
      await createEvalCasesInBatches(client, { suiteId: "suite_1", cases });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Error);
    // The first chunk's cases are PERSISTED. Reporting them as failed would
    // send the caller into a retry that authors them a second time.
    const partial = partialResultOf(thrown);
    expect(partial.committed).toHaveLength(MAX_CASES_PER_BATCH);
    expect(partial.committed.at(-1)).toMatchObject({
      index: MAX_CASES_PER_BATCH - 1,
    });
  });

  it("carries an empty partial when the FIRST chunk is rejected", async () => {
    const { client } = fakeConvexClient({ throwOnChunk: 0 });
    let thrown: unknown;
    try {
      await createEvalCasesInBatches(client, {
        suiteId: "suite_1",
        cases: [{ title: "a" }],
      });
    } catch (error) {
      thrown = error;
    }
    // "Nothing was written" is simply true here.
    expect(partialResultOf(thrown).committed).toEqual([]);
  });
});

describe("authorEvalSuite: batch authoring", () => {
  it("authors N cases in ONE mutation, each carrying a declared id", async () => {
    const { client, calls } = fakeConvexClient();
    const result = await authorEvalSuite(
      authorArgs({
        convexClient: client,
        tests: ["a", "b", "c"].map(buildTest),
      })
    );

    const batchCalls = calls.filter(
      (c) => c.name === "testSuites:createTestCases"
    );
    expect(batchCalls).toHaveLength(1);
    expect(batchCalls[0].args.cases).toHaveLength(3);
    // Every authored case has an identity by the time it reaches the platform.
    for (const item of batchCalls[0].args.cases) {
      expect(isOpaqueId(item.caseId)).toBe(true);
    }
    // No case is written through the per-case mutation any more.
    expect(calls.some((c) => c.name === "testSuites:createTestCase")).toBe(
      false
    );
    expect(result.caseUpsert.committed.map((x) => x.name)).toEqual([
      "a",
      "b",
      "c",
    ]);
    expect(result.caseUpsert.failed).toEqual([]);
  });

  it("returns the platform's case id for each committed case", async () => {
    const { client } = fakeConvexClient();
    const result = await authorEvalSuite(
      authorArgs({ convexClient: client, tests: [buildTest("a")] })
    );
    expect(result.caseUpsert.committed[0]).toEqual({
      id: "case_0",
      name: "a",
    });
  });

  it("keeps a per-item failure from taking its siblings down, and preserves order", async () => {
    const { client } = fakeConvexClient({
      failTitles: { b: "positive cases need an assertion" },
    });
    const result = await authorEvalSuite(
      authorArgs({
        convexClient: client,
        tests: ["a", "b", "c"].map(buildTest),
      })
    );
    expect(result.caseUpsert.committed.map((x) => x.name)).toEqual(["a", "c"]);
    expect(result.caseUpsert.failed).toEqual([
      {
        name: "b",
        error: expect.stringContaining("positive cases need an assertion"),
      },
    ]);
  });

  it("derives each case's idempotency key from its dedupe key, not its position", async () => {
    const tests = ["a", "b"].map(buildTest);
    const { client, calls } = fakeConvexClient();
    await authorEvalSuite(
      authorArgs({ convexClient: client, tests, idempotencyKey: "turn_1" })
    );
    const forward = calls
      .find((c) => c.name === "testSuites:createTestCases")!
      .args.cases.map((item: any) => item.idempotencyKey);

    // The SAME cases in the opposite order must derive the same keys, or a
    // retry whose order differs would author every case a second time.
    const reversed = fakeConvexClient();
    await authorEvalSuite(
      authorArgs({
        convexClient: reversed.client,
        tests: [...tests].reverse(),
        idempotencyKey: "turn_1",
      })
    );
    const backward = reversed.calls
      .find((c) => c.name === "testSuites:createTestCases")!
      .args.cases.map((item: any) => item.idempotencyKey);

    expect(forward.every((k: string) => typeof k === "string")).toBe(true);
    expect([...forward].sort()).toEqual([...backward].sort());
  });

  it("sends no idempotency key when the caller supplied none", async () => {
    const { client, calls } = fakeConvexClient();
    await authorEvalSuite(
      authorArgs({ convexClient: client, tests: [buildTest("a")] })
    );
    expect(
      calls.find((c) => c.name === "testSuites:createTestCases")!.args.cases[0]
        .idempotencyKey
    ).toBeUndefined();
  });

  it("turns a whole-call rejection into one failure per case, and rolls the empty suite back", async () => {
    const { client, calls } = fakeConvexClient({
      throwOnBatch: new Error("Not authorized"),
    });
    await expect(
      authorEvalSuite(
        authorArgs({
          convexClient: client,
          tests: ["a", "b"].map(buildTest),
        })
      )
      // Every case failed, so the freshly-created suite would be left empty.
    ).rejects.toThrow(/Failed to save any of 2 test case\(s\)/);
    expect(calls.some((c) => c.name === "testSuites:deleteTestSuite")).toBe(
      true
    );
  });

  it("keeps the cases an interrupted batch DID commit out of the failed list", async () => {
    const { client } = fakeConvexClient({ throwOnChunk: 1 });
    const result = await authorEvalSuite(
      authorArgs({
        convexClient: client,
        tests: Array.from({ length: MAX_CASES_PER_BATCH + 3 }, (_, i) =>
          buildTest(`case-${i}`)
        ),
      })
    );
    // The first chunk landed; only the cases the rejected call never reached
    // are reported as failures.
    expect(result.caseUpsert.committed).toHaveLength(MAX_CASES_PER_BATCH);
    expect(result.caseUpsert.failed).toHaveLength(3);
    expect(result.caseUpsert.failed[0].error).toContain("Not authorized");
  });

  it("does not write a declared id into the storage caseKey (D7)", async () => {
    const { client, calls } = fakeConvexClient();
    await authorEvalSuite(
      authorArgs({ convexClient: client, tests: [buildTest("a")] })
    );
    const item = calls.find((c) => c.name === "testSuites:createTestCases")!
      .args.cases[0];
    expect(item.caseId).toBeDefined();
    expect(item.caseKey).toBeUndefined();
  });
});

describe("deriveItemIdempotencyKey", () => {
  it("is stable for the same operation key and discriminator", () => {
    expect(deriveItemIdempotencyKey("op", "case-a")).toBe(
      deriveItemIdempotencyKey("op", "case-a")
    );
    expect(deriveItemIdempotencyKey("op", "case-a")).not.toBe(
      deriveItemIdempotencyKey("op", "case-b")
    );
  });
});
