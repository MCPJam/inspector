import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, renderHook, screen } from "@testing-library/react";

const toastWarning = vi.hoisted(() => vi.fn());
vi.mock("@/lib/toast", () => ({
  toast: { warning: toastWarning },
}));

import {
  RunErrorBreakdownDescription,
  useRunErrorBreakdownToast,
} from "../run-error-breakdown";
import type { RunErrorBreakdown as RunErrorBreakdownView } from "../run-error-breakdown-model";

const breakdown: RunErrorBreakdownView = {
  errored: 26,
  finished: 26,
  headline: "All 26 results in this run ended in an error.",
  groups: [
    {
      cause: "serverError",
      owner: "yourServer",
      title: "Your MCP server returned an error",
      nextStep: "Open a result to read the error your server sent back.",
      count: 26,
    },
  ],
};

describe("RunErrorBreakdownDescription", () => {
  it("says who needs to act and what to do", () => {
    render(<RunErrorBreakdownDescription breakdown={breakdown} />);
    expect(
      screen.getByText(
        "Your server: Your MCP server returned an error (26 of 26)",
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "Open a result to read the error your server sent back.",
      ),
    ).toBeInTheDocument();
  });
});

describe("useRunErrorBreakdownToast", () => {
  beforeEach(() => toastWarning.mockClear());

  it("stays quiet without a breakdown", () => {
    renderHook(() => useRunErrorBreakdownToast("run_1", null));
    expect(toastWarning).not.toHaveBeenCalled();
  });

  it("toasts once per run, however often the page re-renders", () => {
    const { rerender } = renderHook(
      ({ runId, value }) => useRunErrorBreakdownToast(runId, value),
      { initialProps: { runId: "run_1", value: breakdown } },
    );
    rerender({ runId: "run_1", value: { ...breakdown } });
    expect(toastWarning).toHaveBeenCalledTimes(1);
    expect(toastWarning).toHaveBeenCalledWith(
      breakdown.headline,
      expect.objectContaining({ id: "run-error-breakdown-run_1" }),
    );

    rerender({ runId: "run_2", value: breakdown });
    expect(toastWarning).toHaveBeenCalledTimes(2);
  });
});
