import { useState } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { SuiteListRunReview } from "../suite-list-run-review";

const data = vi.hoisted(() => ({ details: undefined as unknown }));
vi.mock("convex/react", () => ({
  useConvexAuth: () => ({ isAuthenticated: true }),
  useQuery: () => data.details,
}));
vi.mock("@/contexts/db-user-ready-context", () => ({
  useDbUserReady: () => true,
}));
vi.mock("@/hooks/useClients", () => ({ useHostList: () => ({ hosts: [] }) }));
vi.mock("@/hooks/useProjectEnvironments", () => ({
  useProjectEnvironments: () => [],
}));
vi.mock("../suite-run-review", () => ({
  SuiteRunReview: ({ cases }: { cases: unknown[] }) => {
    const [repetitions, setRepetitions] = useState("3");
    return (
      <>
        <input
          aria-label="Iterations"
          value={repetitions}
          onChange={(event) => setRepetitions(event.target.value)}
        />
        <span>{cases.length} loaded cases</span>
      </>
    );
  },
}));

describe("SuiteListRunReview", () => {
  it("keeps the drawer mounted and preserves edits as case data arrives", () => {
    data.details = undefined;
    const props = {
      suite: { _id: "suite", name: "Suite", projectId: "project" } as any,
      onClose: vi.fn(),
      onStart: vi.fn(),
    };
    const { rerender } = render(<SuiteListRunReview {...props} />);
    const input = screen.getByLabelText("Iterations");
    fireEvent.change(input, { target: { value: "7" } });
    data.details = { testCases: [{ _id: "case" }] };
    rerender(<SuiteListRunReview {...props} />);
    expect(screen.getByLabelText("Iterations")).toBe(input);
    expect(input).toHaveValue("7");
    expect(screen.getByText("1 loaded cases")).toBeVisible();
  });
});
