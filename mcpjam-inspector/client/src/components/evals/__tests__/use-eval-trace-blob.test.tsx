import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useEvalTraceBlob } from "../use-eval-trace-blob";
import type { EvalIteration } from "../types";

const mockGetBlob = vi.hoisted(() => vi.fn());

vi.mock("convex/react", () => ({
  useAction: () => mockGetBlob,
}));

describe("useEvalTraceBlob", () => {
  beforeEach(() => {
    mockGetBlob.mockReset();
  });

  it("builds trace data from inline guest iteration fields without fetching a blob", async () => {
    const onTraceLoaded = vi.fn();
    const iteration: EvalIteration = {
      _id: "guestiter-1",
      createdBy: "__guest__",
      createdAt: 1,
      updatedAt: 2,
      iterationNumber: 1,
      status: "completed",
      result: "failed",
      actualToolCalls: [],
      tokensUsed: 42,
      messages: [{ role: "user", content: "hello" }] as EvalIteration["messages"],
      spans: [
        {
          id: "step-1",
          name: "Step 1",
          category: "step",
          startMs: 0,
          endMs: 1,
        },
      ],
      prompts: [
        {
          promptIndex: 0,
          prompt: "hello",
          expectedToolCalls: [],
          actualToolCalls: [],
          passed: false,
          missing: [],
          unexpected: [],
          argumentMismatches: [],
        },
      ],
    };

    const { result } = renderHook(() =>
      useEvalTraceBlob({
        iteration,
        onTraceLoaded,
      }),
    );

    await waitFor(() => {
      expect(result.current.blob).toEqual({
        traceVersion: 1,
        messages: [{ role: "user", content: "hello" }],
        spans: iteration.spans,
        prompts: iteration.prompts,
      });
    });

    expect(result.current.loading).toBe(false);
    expect(result.current.error).toBeNull();
    expect(mockGetBlob).not.toHaveBeenCalled();
    expect(onTraceLoaded).toHaveBeenCalledTimes(1);
  });
});
