import { describe, expect, it } from "vitest";
import type { CompareRunRecord, EvalIteration } from "../../evals/types";
import {
  createAttemptId,
  evidenceKey,
  leftViewFor,
  paneViewFor,
  trialActivity,
  trialKey,
  trialMatchesDraft,
  trialVerdict,
} from "../case-workspace/selected-trial";
import { caseSnapshotSignature } from "../case-workspace/case-snapshot-signature";

function iteration(
  overrides: Partial<EvalIteration> & Pick<EvalIteration, "_id">,
): EvalIteration {
  return {
    testCaseId: "case-1",
    createdBy: "u",
    createdAt: 1,
    iterationNumber: 1,
    updatedAt: 1,
    status: "completed",
    result: "passed",
    actualToolCalls: [],
    tokensUsed: 0,
    ...overrides,
  };
}

function liveRecord(
  overrides: Partial<CompareRunRecord> = {},
): CompareRunRecord {
  return {
    modelValue: "anthropic/claude-haiku-4.5",
    modelLabel: "Haiku",
    provider: "anthropic",
    model: "claude-haiku-4.5",
    status: "running",
    iteration: null,
    startedAt: 1,
    completedAt: null,
    result: "pending",
    metrics: {
      durationMs: null,
      toolCallCount: 0,
      tokensUsed: 0,
      missingCount: null,
      unexpectedCount: null,
      argumentMismatchCount: null,
      mismatchCount: null,
    },
    attemptId: "att_1",
    ...overrides,
  };
}

const promptStep = {
  id: "p1",
  kind: "prompt" as const,
  prompt: "Find incidents",
};

describe("paneViewFor", () => {
  const latest = iteration({
    _id: "latest",
    blob: "blob-latest",
  });
  const explicit = iteration({ _id: "picked", blob: "blob-picked" });
  const live = liveRecord();

  it("prefers an explicit history pick over recording, live, and latest", () => {
    expect(
      paneViewFor({
        explicit: { iteration: explicit, source: "history" },
        liveRecordMode: true,
        showLive: true,
        liveRecord: live,
        latestCandidates: [latest],
        specTrace: { ok: true },
        showSpecOverride: false,
      }),
    ).toEqual({
      kind: "trial",
      trial: { kind: "persisted", iteration: explicit, source: "history" },
    });
  });

  it("lets View spec hide explicit, recording, and live, but not latest", () => {
    expect(
      paneViewFor({
        explicit: { iteration: explicit, source: "history" },
        liveRecordMode: true,
        showLive: true,
        liveRecord: live,
        latestCandidates: [latest],
        specTrace: { ok: true },
        showSpecOverride: true,
      }),
    ).toEqual({
      kind: "trial",
      trial: { kind: "persisted", iteration: latest, source: "latest" },
    });
  });

  it("prefers recording over live and latest", () => {
    expect(
      paneViewFor({
        explicit: null,
        liveRecordMode: true,
        showLive: true,
        liveRecord: live,
        latestCandidates: [latest],
        specTrace: { ok: true },
        showSpecOverride: false,
      }).kind,
    ).toBe("recording");
  });

  it("prefers live over latest", () => {
    expect(
      paneViewFor({
        explicit: null,
        liveRecordMode: false,
        showLive: true,
        liveRecord: live,
        latestCandidates: [latest],
        specTrace: { ok: true },
        showSpecOverride: false,
      }),
    ).toEqual({ kind: "trial", trial: { kind: "live", record: live } });
  });

  it("falls through to spec, then empty", () => {
    expect(
      paneViewFor({
        explicit: null,
        liveRecordMode: false,
        showLive: false,
        liveRecord: null,
        latestCandidates: [iteration({ _id: "no-trace" })],
        specTrace: { ok: true },
        showSpecOverride: false,
      }).kind,
    ).toBe("spec");
    expect(
      paneViewFor({
        explicit: null,
        liveRecordMode: false,
        showLive: false,
        liveRecord: null,
        latestCandidates: [],
        specTrace: null,
        showSpecOverride: false,
      }).kind,
    ).toBe("empty");
  });
});

describe("leftViewFor", () => {
  const draft = { steps: [promptStep], expectedOutput: "" };
  const selected = {
    kind: "persisted" as const,
    iteration: iteration({
      _id: "it-1",
      testCaseSnapshot: {
        title: "t",
        query: "",
        provider: "anthropic",
        model: "haiku",
        expectedToolCalls: [],
        steps: [promptStep],
        expectedOutput: "",
      },
    }),
    source: "history" as const,
  };

  it("inspects when inspect is set", () => {
    const view = leftViewFor({
      inspect: selected.iteration,
      draft,
      selected,
    });
    expect(view.kind).toBe("inspecting");
  });

  it("overlays only while the selected trial matches the draft", () => {
    const matching = leftViewFor({
      inspect: null,
      draft,
      selected,
    });
    expect(matching).toEqual({ kind: "editing", overlay: { trial: selected } });
    const diverged = leftViewFor({
      inspect: null,
      draft: { steps: [{ ...promptStep, prompt: "changed" }] },
      selected,
    });
    expect(diverged).toEqual({ kind: "editing", overlay: null });
  });
});

describe("trialKey / evidenceKey", () => {
  it("keeps a live attempt key after the persisted iteration arrives", () => {
    const record = liveRecord({
      attemptId: "att_keep",
      status: "completed",
      result: "passed",
      iteration: iteration({ _id: "it-done", blob: "blob-1" }),
    });
    const trial = { kind: "live" as const, record };
    expect(trialKey(trial)).toBe("attempt:att_keep");
    expect(evidenceKey(trial)).toBe("blob-1");
    expect(createAttemptId()).not.toBe(createAttemptId());
  });
});

describe("trialVerdict", () => {
  it("says Running while the trial is in flight", () => {
    expect(
      trialVerdict({
        kind: "persisted",
        iteration: iteration({
          _id: "r",
          status: "running",
          result: "pending",
        }),
        source: "latest",
      }).word,
    ).toBe("Running");
    expect(trialVerdict({ kind: "live", record: liveRecord() }).word).toBe(
      "Running",
    );
  });

  it("says No verdict for a completed trial with pending result", () => {
    expect(
      trialVerdict({
        kind: "persisted",
        iteration: iteration({
          _id: "p",
          status: "completed",
          result: "pending",
        }),
        source: "latest",
      }).word,
    ).toBe("No verdict");
  });

  it("lets every lifecycle failure win over a stored passed", () => {
    for (const status of [
      "cancelled",
      "timed_out",
      "setup_failed",
      "skipped",
    ] as const) {
      expect(
        trialVerdict({
          kind: "persisted",
          iteration: iteration({
            _id: status,
            status,
            result: "passed",
          }),
          source: "latest",
        }).word,
      ).toBe("No verdict");
    }
  });

  it("never says Inconclusive", () => {
    expect(
      trialVerdict({
        kind: "persisted",
        iteration: iteration({ _id: "ok", result: "passed" }),
        source: "latest",
      }).word,
    ).toBe("Passed");
  });
});

describe("trialActivity", () => {
  it("is Grading only from run context", () => {
    expect(trialActivity({ run: { status: "grading" } })).toBe("Grading");
    expect(
      trialActivity({
        run: { status: "running", goalCompletionStatus: "pending" },
      }),
    ).toBe("Grading");
    expect(trialActivity({})).toBeNull();
  });
});

describe("caseSnapshotSignature", () => {
  it("ignores step ids and notices grader edits", () => {
    const a = caseSnapshotSignature({
      steps: [promptStep],
      expectedOutput: "ok",
    });
    const b = caseSnapshotSignature({
      steps: [{ ...promptStep, id: "other" }],
      expectedOutput: "ok",
    });
    const c = caseSnapshotSignature({
      steps: [promptStep],
      expectedOutput: "changed",
    });
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });

  it("matches a launch snapshot to the same case", () => {
    const fields = {
      steps: [promptStep],
      predicates: [{ type: "noToolErrors" as const }],
      matchOptions: { toolCallOrder: "ignore" as const },
      expectedOutput: "ok",
    };
    const trial = {
      kind: "live" as const,
      record: liveRecord({ launchSnapshot: fields }),
    };
    expect(trialMatchesDraft(trial, fields)).toBe(true);
  });
});
