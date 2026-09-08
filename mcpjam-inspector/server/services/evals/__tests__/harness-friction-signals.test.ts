/**
 * The harness path's friction evidence — THREE TIERS, and the middle one is
 * the reason any of this is threaded at all.
 *
 *   capture on + complete  → the wire record, with per-call timing;
 *   capture on + a hole    → notMeasured, because half a wire record answers
 *                            "nobody used this identifier" from calls we know
 *                            are missing;
 *   capture off            → nothing, so the deriver reads the transcript:
 *                            retries stay measured and the identifier half
 *                            says honestly that it never looked.
 *
 * Plus the case array position cannot answer: a wire-only call is APPENDED to
 * the graded array, so a later index proves nothing about a later time.
 */

import { describe, expect, it } from "vitest";
import type { ModelMessage } from "ai";
import type { FrictionResultEntry } from "@mcpjam/sdk/contract";
import { buildIterationFinishParams } from "../finalize-iteration.js";
import { collectEvidenceResults } from "../drive-hosted-eval-turn.js";
import type { TurnEvidenceResult } from "../harness-evidence-turn.js";
import type { CanonicalMcpCall } from "../harness-evidence-merge.js";

const usageZero = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };

const searchResult = {
  structuredContent: { results: [{ id: "ISSUE-41" }, { id: "ISSUE-42" }] },
};

const wireCall = (
  over: Partial<CanonicalMcpCall> & { requestId: string },
): CanonicalMcpCall => ({
  serverId: "srv",
  toolName: "search_issues",
  arguments: { q: "open" },
  response: searchResult,
  outcomeKind: "success",
  startedAtMs: 1_000,
  settledAtMs: 1_500,
  ...over,
});

const evidence = (
  over: Partial<NonNullable<TurnEvidenceResult["merge"]>> = {},
): TurnEvidenceResult => ({
  spans: [],
  merge: {
    completeness: { status: "complete" },
    canonicalCalls: [],
    matchedByToolCallId: new Map(),
    wireOnlyCalls: [],
    narrationOnlyToolCallIds: new Set(),
    ...over,
  } as NonNullable<TurnEvidenceResult["merge"]>,
});

const finish = (over: Record<string, unknown>) =>
  buildIterationFinishParams({
    iterationId: "iter1",
    passed: true,
    evaluation: {
      toolsCalled: [],
      turnCount: 1,
      failedTurnCount: 0,
      missing: [],
      unexpected: [],
      argumentMismatches: [],
    },
    usage: usageZero,
    messages: [] as ModelMessage[],
    status: "completed",
    startedAt: 0,
    iterationMetadataBase: {},
    ...over,
  } as Parameters<typeof buildIterationFinishParams>[0]);

const frictionOf = (params: ReturnType<typeof finish>) =>
  (params.metadata as Record<string, unknown>).frictionSignals as Record<
    string,
    unknown
  >;

const twoSearches = {
  toolsCalled: [
    { toolName: "search_issues", toolCallId: "call_0", arguments: { q: "a" } },
    { toolName: "search_issues", toolCallId: "call_1", arguments: { q: "b" } },
  ],
  turnCount: 1,
  failedTurnCount: 0,
  missing: [],
  unexpected: [],
  argumentMismatches: [],
};

describe("collectEvidenceResults", () => {
  it("keys a matched call by its NARRATED id and a wire-only call by request id", () => {
    const acc = {
      evidenceResults: new Map<string, FrictionResultEntry>(),
      evidenceHadHole: { value: false },
    };
    collectEvidenceResults(
      acc,
      evidence({
        matchedByToolCallId: new Map([
          ["call_0", wireCall({ requestId: "req-1" })],
        ]),
        wireOnlyCalls: [
          wireCall({ requestId: "req-7", startedAtMs: 9, settledAtMs: 11 }),
        ],
      }),
    );
    expect([...acc.evidenceResults.keys()].sort()).toEqual([
      "call_0",
      "evidence:req-7",
    ]);
    expect(acc.evidenceResults.get("evidence:req-7")).toMatchObject({
      startedAtMs: 9,
      settledAtMs: 11,
    });
    expect(acc.evidenceHadHole.value).toBe(false);
  });

  it("accumulates across turns without losing an earlier turn's results", () => {
    const acc = {
      evidenceResults: new Map<string, FrictionResultEntry>(),
      evidenceHadHole: { value: false },
    };
    collectEvidenceResults(
      acc,
      evidence({
        matchedByToolCallId: new Map([
          ["call_0", wireCall({ requestId: "req-1" })],
        ]),
      }),
    );
    collectEvidenceResults(
      acc,
      evidence({
        matchedByToolCallId: new Map([
          ["call_1", wireCall({ requestId: "req-2" })],
        ]),
      }),
    );
    expect([...acc.evidenceResults.keys()].sort()).toEqual([
      "call_0",
      "call_1",
    ]);
  });

  it("an incomplete turn contributes nothing and taints the iteration", () => {
    const acc = {
      evidenceResults: new Map<string, FrictionResultEntry>(),
      evidenceHadHole: { value: false },
    };
    collectEvidenceResults(
      acc,
      evidence({
        completeness: { status: "incomplete", reason: "unsettled_row" },
        matchedByToolCallId: new Map([
          ["call_0", wireCall({ requestId: "req-1" })],
        ]),
      }),
    );
    expect(acc.evidenceResults.size).toBe(0);
    expect(acc.evidenceHadHole.value).toBe(true);
  });

  it("a turn with no merge at all is a no-op, not a hole", () => {
    const acc = {
      evidenceResults: new Map<string, FrictionResultEntry>(),
      evidenceHadHole: { value: false },
    };
    collectEvidenceResults(acc, { spans: [] });
    expect(acc.evidenceHadHole.value).toBe(false);
    expect(acc.evidenceResults.size).toBe(0);
  });
});

describe("the three tiers", () => {
  it("capture on + complete measures identifiers from the wire", () => {
    const friction = frictionOf(
      finish({
        evaluation: twoSearches,
        frictionEvidence: {
          kind: "harnessEvidence",
          resultsByToolCallId: new Map<string, FrictionResultEntry>([
            [
              "call_0",
              { raw: searchResult, startedAtMs: 1_000, settledAtMs: 1_500 },
            ],
            ["call_1", { raw: {}, startedAtMs: 2_000, settledAtMs: 2_500 }],
          ]),
        },
      }),
    );
    expect(friction).toMatchObject({
      state: "measured",
      resultAvailableCount: 2,
      timedCallCount: 2,
      identifierSignals: { state: "measured" },
    });
  });

  it("capture on + a hole is notMeasured, with the call count still honest", () => {
    const friction = frictionOf(
      finish({
        evaluation: twoSearches,
        frictionEvidence: {
          kind: "notMeasured",
          reason: "evidenceIncomplete",
        },
      }),
    );
    expect(friction).toMatchObject({
      state: "notMeasured",
      notMeasuredReason: "evidenceIncomplete",
      callCount: 2,
      signals: [],
    });
  });

  it("capture off measures the retries and refuses the identifier claim", () => {
    const friction = frictionOf(finish({ evaluation: twoSearches }));
    expect(friction).toMatchObject({
      state: "measured",
      resultAvailableCount: 0,
      identifierSignals: {
        state: "notMeasured",
        reason: "resultsUnavailable",
      },
    });
    expect(
      (friction.signals as { kind: string }[]).map((signal) => signal.kind),
    ).toEqual(["changedRetry"]);
  });

  it("an appended wire-only call that settled FIRST is not a later call", () => {
    const friction = frictionOf(
      finish({
        evaluation: {
          ...twoSearches,
          toolsCalled: [
            {
              toolName: "search_issues",
              toolCallId: "call_0",
              arguments: { q: "open" },
            },
            {
              toolName: "get_issue",
              toolCallId: "call_1",
              arguments: { title: "x" },
            },
            {
              toolName: "get_issue",
              toolCallId: "call_2",
              arguments: { title: "y" },
            },
            // Appended by the merge at the END of the graded array, and
            // settled BEFORE the search. Position says "later"; time says no.
            {
              toolName: "list_pages",
              toolCallId: "evidence:req-7",
              arguments: { page: 1 },
            },
          ],
        },
        frictionEvidence: {
          kind: "harnessEvidence",
          resultsByToolCallId: new Map<string, FrictionResultEntry>([
            [
              "call_0",
              { raw: searchResult, startedAtMs: 3_000, settledAtMs: 4_000 },
            ],
            ["call_1", { raw: {}, startedAtMs: 5_000, settledAtMs: 5_500 }],
            ["call_2", { raw: {}, startedAtMs: 6_000, settledAtMs: 6_500 }],
            [
              "evidence:req-7",
              { raw: {}, startedAtMs: 1_000, settledAtMs: 1_500 },
            ],
          ]),
        },
      }),
    );
    const unused = (friction.signals as { kind: string }[]).filter(
      (signal) => signal.kind === "identifierSurfacedUnused",
    );
    // Two calls DID start after the search settled, so the signal fires — and
    // it names the last of THOSE, never the appended call.
    expect(unused).toHaveLength(1);
    expect(unused[0]).toMatchObject({
      informationCallIndex: 0,
      observedAtCallIndex: 2,
    });
  });
});
