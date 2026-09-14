/**
 * The controller's contract: one request per click, one controller per scope,
 * and an older backend that says so instead of failing silently.
 */
import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { useUnifiedFindings } from "../use-unified-findings";
import type { InsightsEnvelope } from "@/lib/insights-envelope-api";

const mutation = vi.hoisted(() => ({
  fn: vi.fn(async () => ({ jobId: "job-1" })),
}));
vi.mock("convex/react", () => ({
  useMutation: () => mutation.fn,
}));

const ENVELOPE: InsightsEnvelope = JSON.parse(
  readFileSync(
    join(
      dirname(fileURLToPath(import.meta.url)),
      "fixtures",
      "wire-parity-envelope.json",
    ),
    "utf8",
  ),
) as InsightsEnvelope;

function generation(overrides: Record<string, unknown> = {}) {
  return {
    pending: false,
    failedGeneration: false,
    error: null,
    unavailable: false,
    canRequest: true,
    requestInsight: vi.fn(),
    ...overrides,
  };
}

beforeEach(() => {
  mutation.fn.mockClear();
  mutation.fn.mockImplementation(async () => ({ jobId: "job-1" }));
});

describe("build", () => {
  it("asks once per click and never on mount", () => {
    const { result } = renderHook(() =>
      useUnifiedFindings({
        suiteRunId: "run_1",
        envelope: ENVELOPE,
        generation: generation(),
      }),
    );
    expect(mutation.fn).not.toHaveBeenCalled();
    act(() => result.current.build.onRun());
    expect(mutation.fn).toHaveBeenCalledTimes(1);
  });

  it("coalesces a double-click into one request", async () => {
    let resolveRequest: (() => void) | undefined;
    mutation.fn.mockImplementation(
      () =>
        new Promise<{ jobId: string }>((resolve) => {
          resolveRequest = () => resolve({ jobId: "job-1" });
        }),
    );
    const { result } = renderHook(() =>
      useUnifiedFindings({
        suiteRunId: "run_1",
        envelope: ENVELOPE,
        generation: generation(),
      }),
    );
    act(() => {
      result.current.build.onRun();
      result.current.build.onRun();
    });
    expect(mutation.fn).toHaveBeenCalledTimes(1);
    await act(async () => {
      resolveRequest?.();
    });
  });

  it("rebuilds with force when a snapshot already exists", () => {
    const { result } = renderHook(() =>
      useUnifiedFindings({
        suiteRunId: "run_1",
        envelope: ENVELOPE,
        generation: generation(),
      }),
    );
    act(() => result.current.build.onRun());
    expect(mutation.fn).toHaveBeenCalledWith({
      suiteRunId: "run_1",
      force: true,
    });
  });

  it("surfaces a refusal rather than swallowing it", async () => {
    mutation.fn.mockImplementation(async () => {
      throw new Error("Findings are already being built.");
    });
    const { result } = renderHook(() =>
      useUnifiedFindings({
        suiteRunId: "run_1",
        envelope: ENVELOPE,
        generation: generation(),
      }),
    );
    await act(async () => {
      result.current.build.onRun();
    });
    expect(result.current.build.error).toContain("already being built");
  });
});

describe("enrich", () => {
  it("borrows the page's controller and asks for the experimental mode", () => {
    const borrowed = generation();
    const { result } = renderHook(() =>
      useUnifiedFindings({
        suiteRunId: "run_1",
        envelope: ENVELOPE,
        generation: borrowed,
      }),
    );
    act(() => result.current.enrich.onRun());
    expect(borrowed.requestInsight).toHaveBeenCalledTimes(1);
    expect(borrowed.requestInsight).toHaveBeenCalledWith(true, {
      mode: "findings",
    });
    // The build mutation is untouched: the two operations are separate.
    expect(mutation.fn).not.toHaveBeenCalled();
  });

  it("reports a generation failure without disturbing the build state", () => {
    const { result } = renderHook(() =>
      useUnifiedFindings({
        suiteRunId: "run_1",
        envelope: ENVELOPE,
        generation: generation({
          failedGeneration: true,
          error: "provider returned 503",
        }),
      }),
    );
    expect(result.current.enrich.error).toContain("503");
    expect(result.current.build.error).toBeNull();
  });
});

describe("view selection", () => {
  it("shows the deterministic findings by default", () => {
    const { result } = renderHook(() =>
      useUnifiedFindings({
        suiteRunId: "run_1",
        envelope: ENVELOPE,
        generation: generation(),
      }),
    );
    expect(result.current.mode).toBe("deterministic");
    expect(result.current.findings).toBe(
      ENVELOPE.unifiedFindings!.snapshot!.deterministicFindings,
    );
  });

  it("switching to AI selects the current view through the shared selector", () => {
    const { result } = renderHook(() =>
      useUnifiedFindings({
        suiteRunId: "run_1",
        envelope: ENVELOPE,
        generation: generation(),
      }),
    );
    act(() => result.current.setMode("ai"));
    expect(result.current.findings).toBe(ENVELOPE.currentFindings);
  });
});

describe("an older backend", () => {
  it("says the pairing is incomplete instead of retrying", () => {
    const { unifiedFindings: _dropped, ...legacy } = ENVELOPE;
    void _dropped;
    const { result } = renderHook(() =>
      useUnifiedFindings({
        suiteRunId: "run_1",
        envelope: legacy as InsightsEnvelope,
        generation: generation(),
      }),
    );
    expect(result.current.backendUnavailableNote).toContain(
      "does not serve it",
    );
    expect(result.current.build.available).toBe(false);
    expect(mutation.fn).not.toHaveBeenCalled();
  });

  it("distinguishes a gate that is off from a backend that is missing", () => {
    const gateOff: InsightsEnvelope = {
      ...ENVELOPE,
      unifiedFindings: {
        ...ENVELOPE.unifiedFindings!,
        writesEnabled: false,
        canBuild: false,
        canEnrich: false,
      },
    };
    const { result } = renderHook(() =>
      useUnifiedFindings({
        suiteRunId: "run_1",
        envelope: gateOff,
        generation: generation(),
      }),
    );
    expect(result.current.backendUnavailableNote).toContain(
      "write gate is off",
    );
    // Reads still work: the snapshot that exists is still on screen.
    expect(result.current.findings.length).toBeGreaterThan(0);
  });

  it("says nothing at all while the envelope is still loading", () => {
    const { result } = renderHook(() =>
      useUnifiedFindings({
        suiteRunId: "run_1",
        envelope: undefined,
        generation: generation(),
      }),
    );
    expect(result.current.backendUnavailableNote).toBeNull();
    expect(result.current.findings).toEqual([]);
  });
});
