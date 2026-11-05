import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";

const { useSharedArtifactMock } = vi.hoisted(() => ({
  useSharedArtifactMock: vi.fn(),
}));

vi.mock("@/hooks/useSharedArtifact", () => ({
  useSharedArtifact: (...args: unknown[]) => useSharedArtifactMock(...args),
}));

vi.mock("convex/react", () => ({
  useQuery: vi.fn(),
  useMutation: () => vi.fn(),
  useAction: () => vi.fn(),
}));

import { ConformanceSharedPage } from "../ConformanceHistory";
import { SUITE_COPY } from "../conformance-ui";

function sharedRun() {
  return {
    score: 87,
    outcome: "failed",
    applicable: 42,
    passed: 38,
    failed: 3,
    couldNotRun: 1,
    notApplicable: 33,
    protocolVersion: "2025-06-18",
    requestedSuites: ["protocol", "apps"],
    verification: "client_reported",
    createdAt: Date.UTC(2026, 9, 28),
    reports: {
      apps: {
        outcome: "failed",
        score: { score: 43, outcome: "failed", applicable: 5, passed: 2 },
        groups: [
          {
            cases: [
              {
                id: "widget-csp",
                title: "Widget CSP declared",
                status: "failed",
                error: "No CSP on the widget resource",
              },
            ],
          },
        ],
      },
      protocol: {
        outcome: "passed",
        score: { score: 100, outcome: "passed", applicable: 14, passed: 14 },
        groups: [{ cases: [{ id: "ping", title: "Ping", status: "passed" }] }],
        advisories: [
          {
            id: "readiness-tool-order-deterministic",
            title: "Tool order is stable",
            group: "mcp-1",
            kind: "readiness",
            status: "SHOULD",
            message: "Return tools in the same order.",
          },
        ],
      },
    },
  };
}

describe("ConformanceSharedPage", () => {
  beforeEach(() => {
    useSharedArtifactMock.mockReset();
  });

  it("shows saved missing-input checks as gray Not run rows with setup copy", () => {
    const message =
      "no probe tool could be selected automatically: tools are chosen by `execution.taskSupport`";
    useSharedArtifactMock.mockReturnValue({
      loading: false,
      error: null,
      redeem: null,
      artifact: {
        score: 100,
        outcome: "incomplete",
        applicable: 1,
        passed: 1,
        failed: 0,
        couldNotRun: 1,
        requestedSuites: ["tasks"],
        reports: {
          tasks: {
            outcome: "incomplete",
            incompleteReason: message,
            score: {
              score: 100,
              outcome: "incomplete",
              applicable: 1,
              passed: 1,
              failed: 0,
              couldNotRun: 1,
            },
            groups: [
              {
                cases: [
                  {
                    id: "tasks-result-type-discipline",
                    title: "Result Type Discipline",
                    status: "skipped",
                    skipReason: "could-not-run",
                    error: message,
                  },
                ],
              },
            ],
          },
        },
      },
    });
    render(<ConformanceSharedPage token="tok" />);
    expect(screen.getByText("Not run")).toHaveAttribute(
      "title",
      "This check needs an input before it can run.",
    );
    expect(
      within(
        screen.getByRole("button", { name: /Result Type Discipline/ }),
      ).getByText(
        "Select a tool that creates a task in setup, then run again.",
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText(message)).toBeNull();
    expect(screen.getByText("Result Type Discipline")).toBeInTheDocument();
  });

  it("shows the run as score card and suite rows, not raw JSON", () => {
    useSharedArtifactMock.mockReturnValue({
      loading: false,
      error: null,
      artifact: sharedRun(),
      redeem: null,
    });
    render(<ConformanceSharedPage token="tok" />);

    expect(screen.getByText(/OVERALL SCORE/)).toBeInTheDocument();
    expect(
      screen.getByText(SUITE_COPY.protocol.description),
    ).toBeInTheDocument();
    expect(screen.getByText(SUITE_COPY.apps.description)).toBeInTheDocument();
    // A failed suite opens to its checks, read from the artifact itself.
    expect(screen.getByText("Widget CSP declared")).toBeInTheDocument();
    expect(
      within(screen.getByRole("button", { name: /Widget CSP declared/ }))
        .getByText("No CSP on the widget resource")
        .parentElement,
    ).toHaveClass("border-red-500/20", "bg-red-500/5");
    expect(screen.queryByText(/"reports"/)).toBeNull();
    // A public page makes no verification claim, either way.
    expect(screen.queryByText("MCPJam-verified")).toBeNull();
    expect(screen.queryByText("Client-reported")).toBeNull();
  });

  it("lists the advice the shared reports hold", () => {
    useSharedArtifactMock.mockReturnValue({
      loading: false,
      error: null,
      artifact: sharedRun(),
      redeem: null,
    });
    render(<ConformanceSharedPage token="tok" />);

    const header = screen.getByRole("button", {
      name: /^Additional enhancements/,
    });
    expect(header).toHaveTextContent("Additional enhancements1");
    fireEvent.click(header);
    expect(screen.getByText("Tool order is stable")).toBeInTheDocument();
    expect(
      screen.getByText("Return tools in the same order."),
    ).toBeInTheDocument();
  });

  it("claims nothing about verification when the artifact has no field", () => {
    const withoutVerification: Partial<ReturnType<typeof sharedRun>> =
      sharedRun();
    delete withoutVerification.verification;
    useSharedArtifactMock.mockReturnValue({
      loading: false,
      error: null,
      artifact: withoutVerification,
      redeem: null,
    });
    render(<ConformanceSharedPage token="tok" />);

    expect(screen.getByText(/OVERALL SCORE/)).toBeInTheDocument();
    expect(screen.queryByText("MCPJam-verified")).toBeNull();
  });

  it("reads a suite with no outcome from its passed flag, as the SDK does", () => {
    const shared = sharedRun();
    shared.reports.protocol = {
      passed: false,
      score: { score: 50, applicable: 2, passed: 1 },
      groups: [{ cases: [{ id: "ping", title: "Ping", status: "failed" }] }],
    } as unknown as typeof shared.reports.protocol;
    useSharedArtifactMock.mockReturnValue({
      loading: false,
      error: null,
      artifact: shared,
      redeem: null,
    });
    render(<ConformanceSharedPage token="tok" />);

    expect(screen.getAllByText("FAILED").length).toBe(2);
    expect(screen.queryByText("PASSED")).toBeNull();
  });

  it("says the link is not available when the redeem is denied", () => {
    useSharedArtifactMock.mockReturnValue({
      loading: false,
      error: "denied",
      artifact: null,
      redeem: null,
    });
    render(<ConformanceSharedPage token="tok" />);

    expect(screen.getByRole("alert")).toBeInTheDocument();
    expect(screen.queryByText(/OVERALL SCORE/)).toBeNull();
  });
});
