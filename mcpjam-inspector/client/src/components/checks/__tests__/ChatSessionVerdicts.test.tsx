import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach } from "vitest";

const useQueryMock = vi.hoisted(() => vi.fn());
const useConvexAuthMock = vi.hoisted(() => vi.fn());

vi.mock("convex/react", () => ({
  useQuery: useQueryMock,
  useConvexAuth: useConvexAuthMock,
}));

import { ChatSessionVerdicts } from "../ChatSessionVerdicts";

describe("<ChatSessionVerdicts>", () => {
  beforeEach(() => {
    useQueryMock.mockReset();
    useConvexAuthMock.mockReset();
    useConvexAuthMock.mockReturnValue({
      isAuthenticated: true,
      isLoading: false,
    });
  });

  it("renders a loading state while the Convex subscription is hydrating", () => {
    useQueryMock.mockReturnValue(undefined);
    render(<ChatSessionVerdicts chatSessionId="sess-1" />);
    expect(screen.getByRole("status")).toHaveTextContent(/Loading checks/i);
  });

  it("renders the empty-state hint when no check runs exist for the session", () => {
    useQueryMock.mockReturnValue([]);
    render(<ChatSessionVerdicts chatSessionId="sess-1" />);
    expect(
      screen.getByTestId("chat-session-verdicts-empty"),
    ).toHaveTextContent(/No checks run on this session yet/i);
  });

  it("renders a RUNNING check with its predicate preview", () => {
    useQueryMock.mockReturnValue([
      {
        _id: "run-1",
        _creationTime: 1,
        chatSessionId: "sess-1",
        status: "running",
        setKind: "suite_defaults",
        setRef: "suite-1",
        setVersion: 7,
        predicates: [
          { type: "toolCalledAtLeastOnce", toolName: "search" },
        ],
      },
    ]);
    render(<ChatSessionVerdicts chatSessionId="sess-1" />);
    expect(screen.getByTestId("check-run-run-1")).toBeInTheDocument();
    expect(screen.getByLabelText(/status: running/i)).toBeInTheDocument();
    expect(screen.getByText(/toolCalledAtLeastOnce/)).toBeInTheDocument();
    expect(screen.getByText(/Suite defaults/)).toBeInTheDocument();
    expect(screen.getByText(/v7/)).toBeInTheDocument();
  });

  it("renders COMPLETED predicate results via shared PredicateVerdictRow markup", () => {
    useQueryMock.mockReturnValue([
      {
        _id: "run-2",
        _creationTime: 2,
        chatSessionId: "sess-1",
        status: "completed",
        setKind: "suite_defaults",
        setRef: "suite-1",
        setVersion: 7,
        predicates: [
          { type: "toolCalledAtLeastOnce", toolName: "search" },
          { type: "tokenBudgetUnder", tokens: 500 },
        ],
        predicateResults: [
          {
            predicate: { type: "toolCalledAtLeastOnce", toolName: "search" },
            passed: true,
            reason: 'tool "search" called 2×',
          },
          {
            predicate: { type: "tokenBudgetUnder", tokens: 500 },
            passed: false,
            reason: "total tokens 643 exceeds budget 500",
          },
        ],
      },
    ]);
    render(<ChatSessionVerdicts chatSessionId="sess-1" />);
    expect(screen.getByLabelText(/status: completed/i)).toBeInTheDocument();
    // Summary badge mirrors PredicatesList wording (passed / total).
    expect(screen.getByText(/1 \/ 2 passed/)).toBeInTheDocument();
    // PASS / FAIL labels from PredicateVerdictRow.
    expect(screen.getByLabelText("passed")).toHaveTextContent("PASS");
    expect(screen.getByLabelText("failed")).toHaveTextContent("FAIL");
    expect(
      screen.getByText("total tokens 643 exceeds budget 500"),
    ).toBeInTheDocument();
  });

  it("renders FAILED state with the operator error message", () => {
    useQueryMock.mockReturnValue([
      {
        _id: "run-3",
        _creationTime: 3,
        chatSessionId: "sess-1",
        status: "failed",
        setKind: "ad_hoc",
        predicates: [],
        errorMessage: "Convex query timed out",
      },
    ]);
    render(<ChatSessionVerdicts chatSessionId="sess-1" />);
    expect(screen.getByLabelText(/status: failed/i)).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent(/timed out/i);
    expect(screen.getByText(/Ad-hoc/)).toBeInTheDocument();
  });

  it("orders runs newest-first by _creationTime", () => {
    useQueryMock.mockReturnValue([
      {
        _id: "run-older",
        _creationTime: 1,
        chatSessionId: "sess-1",
        status: "completed",
        setKind: "suite_defaults",
        predicates: [],
        predicateResults: [],
      },
      {
        _id: "run-newer",
        _creationTime: 2,
        chatSessionId: "sess-1",
        status: "running",
        setKind: "suite_defaults",
        predicates: [],
      },
    ]);
    render(<ChatSessionVerdicts chatSessionId="sess-1" />);
    const cards = screen.getAllByTestId(/check-run-/);
    expect(cards[0].getAttribute("data-testid")).toBe("check-run-run-newer");
    expect(cards[1].getAttribute("data-testid")).toBe("check-run-run-older");
  });

  it("skips the Convex subscription when unauthenticated", () => {
    useConvexAuthMock.mockReturnValue({
      isAuthenticated: false,
      isLoading: false,
    });
    useQueryMock.mockImplementation((_name, args) => {
      // When skipped, useQuery is called with "skip" — return undefined to
      // match Convex semantics. We assert the call shape afterwards.
      return args === "skip" ? undefined : [];
    });
    render(<ChatSessionVerdicts chatSessionId="sess-1" />);
    expect(useQueryMock).toHaveBeenCalled();
    const callArgs = useQueryMock.mock.calls[0];
    expect(callArgs[1]).toBe("skip");
  });
});
