import { describe, expect, it, vi, beforeEach } from "vitest";
import { fireEvent, render, renderHook, screen } from "@testing-library/react";

const toastWarning = vi.hoisted(() => vi.fn());
vi.mock("@/lib/toast", () => ({
  toast: { warning: toastWarning },
}));
const handoff = vi.hoisted(() => ({
  manage: undefined as (() => void) | undefined,
  orgId: vi.fn(),
}));
vi.mock("@/hooks/use-org-models-handoff", () => ({
  useOrgModelsHandoff: (organizationId: string | null) => {
    handoff.orgId(organizationId);
    return handoff.manage;
  },
}));
vi.mock("@/state/app-state-context", () => ({
  useOptionalSharedAppState: () => ({
    projects: { p1: { id: "p1", organizationId: "org_1" } },
  }),
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

describe("RunErrorBreakdownDescription — organization AI provider refusals", () => {
  const refused: RunErrorBreakdownView = {
    errored: 1,
    finished: 1,
    headline: "The only result in this run ended in an error.",
    groups: [
      {
        cause: "orgProviders",
        title: "Your organization's AI provider settings stopped the run",
        errors: [
          { message: "The anthropic provider isn't turned on", count: 1 },
        ],
        count: 1,
      },
    ],
  };
  beforeEach(() => {
    handoff.orgId.mockClear();
    handoff.manage = undefined;
  });

  it("links an org admin to the organization's AI providers", () => {
    const manage = vi.fn();
    handoff.manage = manage;
    render(<RunErrorBreakdownDescription breakdown={refused} projectId="p1" />);
    expect(handoff.orgId).toHaveBeenCalledWith("org_1");
    fireEvent.click(
      screen.getByRole("button", { name: "Manage AI providers" }),
    );
    expect(manage).toHaveBeenCalledTimes(1);
  });

  it("sends a member to an admin instead of a screen they can't open", () => {
    handoff.manage = undefined;
    render(<RunErrorBreakdownDescription breakdown={refused} projectId="p1" />);
    expect(
      screen.queryByRole("button", { name: "Manage AI providers" }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByText(
        "Ask an organization admin to add or reconnect a provider.",
      ),
    ).toBeInTheDocument();
  });

  it("adds nothing to other causes", () => {
    handoff.manage = vi.fn();
    render(
      <RunErrorBreakdownDescription breakdown={breakdown} projectId="p1" />,
    );
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
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
