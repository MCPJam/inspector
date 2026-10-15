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
      title: "Your MCP server returned an error",
      errors: [{ message: "Missing required input filterId", count: 26 }],
      count: 26,
    },
  ],
};

describe("RunErrorBreakdownDescription", () => {
  it("lists recorded errors with counts in a scrollable region", () => {
    render(<RunErrorBreakdownDescription breakdown={breakdown} />);
    expect(
      screen.getByText("Your MCP server returned an error (26 results)"),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Missing required input filterId: 26 results"),
    ).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Run errors" })).toHaveClass(
      "max-h-[min(16rem,40vh)]",
      "overflow-y-auto",
    );
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
      expect.objectContaining({
        id: "run-error-breakdown-run_1",
        duration: 20000,
        closeButton: true,
      }),
    );

    rerender({ runId: "run_2", value: breakdown });
    expect(toastWarning).toHaveBeenCalledTimes(2);
  });
});

it("waits for a breakdown and survives remounts without another toast", () => {
  toastWarning.mockClear();
  const first = renderHook(
    ({ value }) => useRunErrorBreakdownToast("remount", value),
    { initialProps: { value: null as RunErrorBreakdownView | null } },
  );
  expect(toastWarning).not.toHaveBeenCalled();
  first.rerender({ value: breakdown });
  first.unmount();
  renderHook(() => useRunErrorBreakdownToast("remount", breakdown));
  expect(toastWarning).toHaveBeenCalledTimes(1);
});
