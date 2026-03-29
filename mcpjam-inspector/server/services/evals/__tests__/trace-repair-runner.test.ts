import { describe, expect, it, vi } from "vitest";

const { captureToolSnapshotForEvalAuthoringMock } = vi.hoisted(() => ({
  captureToolSnapshotForEvalAuthoringMock: vi.fn(),
}));

vi.mock("../route-helpers.js", async () => {
  const actual = await vi.importActual<typeof import("../route-helpers.js")>(
    "../route-helpers.js",
  );
  return {
    ...actual,
    captureToolSnapshotForEvalAuthoring: (...args: unknown[]) =>
      captureToolSnapshotForEvalAuthoringMock(...args),
  };
});

import {
  captureTraceRepairJobToolSnapshot,
  failedQuickIterationId,
  isTraceRepairGenerationFailureSession,
  parseRefinementCaseConcurrency,
  resolveTraceRepairFailureStopReason,
  runWithConcurrencyLimit,
  signatureFromFailedTraceRepairAttempt,
} from "../trace-repair-runner.js";

describe("parseRefinementCaseConcurrency", () => {
  it("defaults to 2 when unset or empty", () => {
    expect(parseRefinementCaseConcurrency(undefined)).toBe(2);
    expect(parseRefinementCaseConcurrency("")).toBe(2);
  });

  it("clamps to at least 1 via invalid input", () => {
    expect(parseRefinementCaseConcurrency("0")).toBe(2);
    expect(parseRefinementCaseConcurrency("nope")).toBe(2);
  });

  it("caps at 5", () => {
    expect(parseRefinementCaseConcurrency("99")).toBe(5);
  });

  it("accepts in-range integers", () => {
    expect(parseRefinementCaseConcurrency("1")).toBe(1);
    expect(parseRefinementCaseConcurrency("3")).toBe(3);
    expect(parseRefinementCaseConcurrency("5")).toBe(5);
  });
});

describe("runWithConcurrencyLimit", () => {
  it("never exceeds the concurrency limit", async () => {
    let active = 0;
    let maxActive = 0;
    const tick = () => new Promise((r) => setTimeout(r, 10));

    await runWithConcurrencyLimit([0, 1, 2, 3, 4, 5], 3, async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await tick();
      active -= 1;
      return null;
    });

    expect(maxActive).toBe(3);
  });

  it("returns results in input order", async () => {
    const out = await runWithConcurrencyLimit(["a", "b", "c"], 2, async (x, i) => {
      return `${x}:${i}`;
    });
    expect(out).toEqual(["a:0", "b:1", "c:2"]);
  });
});

describe("signatureFromFailedTraceRepairAttempt", () => {
  it("prefers same-model-1 failure signature", () => {
    expect(
      signatureFromFailedTraceRepairAttempt([
        { label: "same-model-1", passed: false, failureSignature: "sig-a" },
      ]),
    ).toBe("sig-a");
  });

  it("uses same-model-2 when first pass passed", () => {
    expect(
      signatureFromFailedTraceRepairAttempt([
        { label: "same-model-1", passed: true },
        { label: "same-model-2", passed: false, failureSignature: "sig-b" },
      ]),
    ).toBe("sig-b");
  });

  it("follows orderedLabels for the first failing quick step", () => {
    expect(
      signatureFromFailedTraceRepairAttempt(
        [
          { label: "same-model-1", passed: true },
          { label: "paraphrase", passed: false, failureSignature: "sig-p" },
        ],
        ["same-model-1", "paraphrase"],
      ),
    ).toBe("sig-p");
  });
});

describe("failedQuickIterationId", () => {
  it("returns failed quick eval iteration id in order", () => {
    expect(
      failedQuickIterationId([
        {
          label: "same-model-1",
          passed: false,
          iterationId: "it1" as unknown as string,
        },
      ]),
    ).toBe("it1");
  });

  it("respects orderedLabels when choosing the failed iteration", () => {
    expect(
      failedQuickIterationId(
        [
          { label: "same-model-1", passed: true, iterationId: "a" as unknown as string },
          { label: "paraphrase", passed: false, iterationId: "b" as unknown as string },
        ],
        ["same-model-1", "paraphrase"],
      ),
    ).toBe("b");
  });
});

describe("isTraceRepairGenerationFailureSession", () => {
  it("detects failed sessions that never produced a candidate revision", () => {
    expect(
      isTraceRepairGenerationFailureSession({
        status: "failed",
        candidateRevisionId: undefined,
        traceRepairDebug: {
          generation: {
            errorMessage: "Could not parse refinement candidate JSON",
            parseStage: "balanced_json",
          },
        },
      }),
    ).toBe(true);
  });

  it("ignores ready sessions and failed sessions with candidate revisions", () => {
    expect(
      isTraceRepairGenerationFailureSession({
        status: "ready",
        traceRepairDebug: {
          generation: {
            errorMessage: "Could not parse refinement candidate JSON",
          },
        },
      }),
    ).toBe(false);
    expect(
      isTraceRepairGenerationFailureSession({
        status: "failed",
        candidateRevisionId: "rev-1",
        traceRepairDebug: {
          generation: {
            errorMessage: "Could not parse refinement candidate JSON",
          },
        },
      }),
    ).toBe(false);
  });
});

describe("resolveTraceRepairFailureStopReason", () => {
  it("returns stopped_generation_error when every attempted case failed before verification", () => {
    expect(
      resolveTraceRepairFailureStopReason(2, [
        { promoted: false, serverLikely: false, generationFailedOnly: true },
        { promoted: false, serverLikely: false, generationFailedOnly: true },
      ]),
    ).toBe("stopped_generation_error");
  });

  it("prefers completed_server_likely when all cases converge on the same signature", () => {
    expect(
      resolveTraceRepairFailureStopReason(2, [
        { promoted: false, serverLikely: true, generationFailedOnly: false },
        { promoted: false, serverLikely: true, generationFailedOnly: false },
      ]),
    ).toBe("completed_server_likely");
  });

  it("returns stopped_no_progress when generation succeeded but nothing was promotable", () => {
    expect(
      resolveTraceRepairFailureStopReason(1, [
        { promoted: false, serverLikely: false, generationFailedOnly: false },
      ]),
    ).toBe("stopped_no_progress");
  });
});

describe("captureTraceRepairJobToolSnapshot", () => {
  it("records the captured job snapshot once for the trace repair job", async () => {
    const toolSnapshot = {
      version: 1,
      capturedAt: 123,
      servers: [
        {
          serverId: "alpha",
          tools: [
            {
              name: "bootstrap",
              description: "Call this before using search.",
              inputSchema: { type: "object" },
            },
          ],
        },
      ],
    };
    const toolSnapshotDebug = {
      captureResult: {
        status: "complete",
        serverCount: 1,
        toolCount: 1,
        failedServerCount: 0,
        failedServerIds: [],
      },
      promptSection: "# Available MCP Tools",
      promptSectionTruncated: false,
      promptSectionMaxChars: 30000,
      fallbackReason: null,
      fullSnapshot: toolSnapshot,
    };
    captureToolSnapshotForEvalAuthoringMock.mockResolvedValue({
      toolSnapshot,
      toolSnapshotDebug,
    });

    const mutationMock = vi.fn().mockResolvedValue(undefined);
    const convexClient = { mutation: mutationMock } as any;
    const replayManager = { name: "replay-manager" } as any;

    await captureTraceRepairJobToolSnapshot({
      convexClient,
      jobId: "job-1",
      leaseOwner: "lease-1",
      replayManager,
      replayServerIds: ["alpha"],
    });

    expect(captureToolSnapshotForEvalAuthoringMock).toHaveBeenCalledWith(
      replayManager,
      ["alpha"],
      {
        logPrefix: "trace-repair",
      },
    );
    expect(mutationMock).toHaveBeenCalledWith(
      "traceRepair:recordTraceRepairToolSnapshot",
      {
        jobId: "job-1",
        leaseOwner: "lease-1",
        toolSnapshot,
        toolSnapshotDebug,
      },
    );
  });

  it("swallows capture failures so the repair job can continue", async () => {
    captureToolSnapshotForEvalAuthoringMock.mockRejectedValueOnce(
      new Error("capture failed"),
    );

    const mutationMock = vi.fn().mockResolvedValue(undefined);

    await expect(
      captureTraceRepairJobToolSnapshot({
        convexClient: { mutation: mutationMock } as any,
        jobId: "job-1",
        leaseOwner: "lease-1",
        replayManager: {} as any,
        replayServerIds: ["alpha"],
      }),
    ).resolves.toBeUndefined();

    expect(mutationMock).not.toHaveBeenCalled();
  });
});
