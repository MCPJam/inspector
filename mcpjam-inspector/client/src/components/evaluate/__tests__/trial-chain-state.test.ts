import { describe, expect, it } from "vitest";
import { trialChainDisplay } from "../case-scorecard/trial-chain-state";

const terminal = (status: string | null | undefined) =>
  status === "completed" || status === "failed";

const base = {
  trialRunId: "run_1",
  hasChain: false,
  readRunId: "run_1",
  readRun: { status: "completed" },
  readRunLoading: false,
  isTerminalRunStatus: terminal,
  chains: { status: "ready" as const, walkExhausted: true },
};

describe("trialChainDisplay", () => {
  it("settles when the trial has its chain, or is a quick run", () => {
    expect(trialChainDisplay({ ...base, hasChain: true })).toBe("settled");
    expect(trialChainDisplay({ ...base, trialRunId: undefined })).toBe(
      "settled",
    );
  });

  it("loads while the chain read is in flight", () => {
    expect(
      trialChainDisplay({ ...base, chains: { status: "loading", walkExhausted: false } }),
    ).toBe("loading");
  });

  it("loads while the trial's run document is still loading", () => {
    expect(
      trialChainDisplay({ ...base, readRun: null, readRunLoading: true }),
    ).toBe("loading");
  });

  it("settles when the run document is gone, so it never spins forever", () => {
    expect(
      trialChainDisplay({ ...base, readRun: null, readRunLoading: false }),
    ).toBe("settled");
  });

  it("waits — a note over the rows, never a forever-skeleton — while the run has not finished", () => {
    expect(
      trialChainDisplay({
        ...base,
        readRun: { status: "running" },
        chains: { status: "disabled", walkExhausted: false },
      }),
    ).toBe("waiting");
  });

  it("reports a failed read as an error, not as an absent chain", () => {
    expect(
      trialChainDisplay({ ...base, chains: { status: "error", walkExhausted: false } }),
    ).toBe("error");
  });

  it("reports a trial past the page cap as not loaded", () => {
    expect(
      trialChainDisplay({ ...base, chains: { status: "ready", walkExhausted: false } }),
    ).toBe("notLoaded");
  });

  it("settles — the honest no-chain fallback — after a full read with no entry", () => {
    expect(trialChainDisplay(base)).toBe("settled");
  });

  it("reports a trial whose run is not the one being read as not loaded", () => {
    expect(
      trialChainDisplay({
        ...base,
        readRunId: "run_2",
        chains: { status: "loading", walkExhausted: false },
      }),
    ).toBe("notLoaded");
  });
});
