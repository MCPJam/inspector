import { describe, expect, it } from "vitest";
import {
  caseRunBatchKey,
  caseRunBatchTrigger,
  groupCaseIterations,
  resolveCaseRunBatchHost,
  suiteRunIdFromBatchKey,
} from "../group-case-iterations";
import type { EvalIteration } from "../../types";

function iter(partial: Partial<EvalIteration>): EvalIteration {
  return {
    _id: "it-1",
    createdAt: 1,
    updatedAt: 1,
    iterationNumber: 1,
    status: "completed",
    result: "passed",
    actualToolCalls: [],
    tokensUsed: 0,
    ...partial,
  } as EvalIteration;
}

describe("caseRunBatchKey", () => {
  it("keys suite-run iterations by suiteRunId", () => {
    expect(caseRunBatchKey(iter({ suiteRunId: "run-9" }))).toBe("suite:run-9");
  });
  it("keys quick-run iterations (no suiteRunId) by compareRunId", () => {
    expect(
      caseRunBatchKey(iter({ metadata: { compareRunId: "cmp-3" } })),
    ).toBe("compare:cmp-3");
  });
  it("falls back to a solo key with neither", () => {
    expect(caseRunBatchKey(iter({ _id: "x" }))).toBe("solo:x");
  });
});

describe("caseRunBatchTrigger", () => {
  it("prefers the explicit iteration.trigger over the key heuristic", () => {
    // Even a `suite:` key reads "quick" when the backend stamped trigger=quick.
    expect(
      caseRunBatchTrigger({
        key: "suite:run-9",
        iterations: [iter({ suiteRunId: "run-9", trigger: "quick" })],
      }),
    ).toBe("quick");
  });
  it("reads replay from the explicit trigger (heuristic can't)", () => {
    expect(
      caseRunBatchTrigger({
        key: "suite:run-9",
        iterations: [iter({ suiteRunId: "run-9", trigger: "replay" })],
      }),
    ).toBe("replay");
  });

  it("legacy fallback: suiteRunId key ⇒ suite when no trigger", () => {
    expect(
      caseRunBatchTrigger({
        key: "suite:run-9",
        iterations: [iter({ suiteRunId: "run-9" })],
      }),
    ).toBe("suite");
  });
  it("legacy fallback: compare/solo key ⇒ quick when no trigger", () => {
    expect(
      caseRunBatchTrigger({ key: "compare:cmp-3", iterations: [iter({})] }),
    ).toBe("quick");
    expect(
      caseRunBatchTrigger({ key: "solo:x", iterations: [iter({})] }),
    ).toBe("quick");
  });

  it("end-to-end: groups + classifies via explicit trigger", () => {
    const batches = groupCaseIterations([
      iter({ _id: "a", suiteRunId: "run-1", trigger: "suite", createdAt: 100 }),
      iter({ _id: "b", trigger: "quick", createdAt: 200 }),
    ]);
    const byTrigger = Object.fromEntries(
      batches.map((b) => [caseRunBatchTrigger(b), b.key]),
    );
    expect(byTrigger.suite).toBe("suite:run-1");
    expect(byTrigger.quick).toBe("solo:b");
  });
});

describe("suiteRunIdFromBatchKey", () => {
  it("extracts the run id from suite batch keys", () => {
    expect(suiteRunIdFromBatchKey("suite:run-9")).toBe("run-9");
  });
  it("returns null for non-suite keys", () => {
    expect(suiteRunIdFromBatchKey("compare:cmp-1")).toBeNull();
  });
});

describe("resolveCaseRunBatchHost", () => {
  const batch = {
    key: "suite:run-9",
    iterations: [iter({ suiteRunId: "run-9" })],
  };

  it("resolves namedHostId from the parent suite run", () => {
    const host = resolveCaseRunBatchHost(batch, {
      runsById: new Map([
        ["run-9", { namedHostId: "host-chatgpt" }],
      ]),
      hostNamesById: new Map([["host-chatgpt", "ChatGPT"]]),
      hasHostAttachments: true,
    });
    expect(host).toEqual({
      hostId: "host-chatgpt",
      hostName: "ChatGPT",
    });
  });

  it("falls back to the suite default label when there are no attachments", () => {
    const host = resolveCaseRunBatchHost(
      { key: "compare:cmp-1", iterations: [iter({})] },
      {
        defaultHostLabel: "MCPJam",
        hasHostAttachments: false,
      },
    );
    expect(host).toEqual({ hostName: "MCPJam" });
  });

  it("omits host for quick runs on multi-host suites", () => {
    const host = resolveCaseRunBatchHost(
      { key: "compare:cmp-1", iterations: [iter({})] },
      {
        defaultHostLabel: "MCPJam",
        hasHostAttachments: true,
      },
    );
    expect(host).toBeNull();
  });
});
