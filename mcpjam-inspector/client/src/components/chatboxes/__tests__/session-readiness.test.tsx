import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
  SessionInsightBar,
  SessionReadinessBadge,
  type SessionReadiness,
} from "../session-readiness";

function ready(overrides: Partial<SessionReadiness> = {}): SessionReadiness {
  return {
    status: "completed",
    verdict: "ready",
    issueCount: 0,
    toolCallCount: 3,
    toolErrorCount: 0,
    advertisedToolCount: 4,
    advertisedToolsKnown: true,
    coverageRatio: 0.75,
    hallucinatedTools: [],
    failingTools: [],
    issues: [],
    ...overrides,
  };
}

describe("SessionReadinessBadge", () => {
  it("renders nothing without readiness", () => {
    const { container } = render(
      <SessionReadinessBadge readiness={undefined} />
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("shows an analyzing state while pending", () => {
    render(<SessionReadinessBadge readiness={ready({ status: "pending" })} />);
    expect(screen.getByText(/analyzing/i)).toBeInTheDocument();
  });

  it("shows the verdict and issue count", () => {
    render(
      <SessionReadinessBadge
        readiness={ready({ verdict: "not_ready", issueCount: 2 })}
      />
    );
    expect(screen.getByText(/Not ready/)).toBeInTheDocument();
    expect(screen.getByText(/· 2/)).toBeInTheDocument();
  });

  it("shows a distinct failed state", () => {
    render(<SessionReadinessBadge readiness={ready({ status: "failed" })} />);
    expect(screen.getByText(/Readiness failed/i)).toBeInTheDocument();
  });
});

describe("SessionInsightBar", () => {
  it("renders findings from server-denormalized fields", () => {
    render(
      <SessionInsightBar
        readiness={ready({
          verdict: "not_ready",
          issueCount: 1,
          toolErrorCount: 2,
          toolCallCount: 4,
          hallucinatedTools: ["made_up_tool"],
          issues: [
            {
              code: "hallucinated_tool",
              severity: "error",
              message:
                'Called "made_up_tool", which is not an advertised tool.',
              toolName: "made_up_tool",
            },
          ],
        })}
      />
    );
    expect(screen.getByText("Not ready")).toBeInTheDocument();
    expect(screen.getByText(/2\/4 tool calls failed/)).toBeInTheDocument();
    expect(screen.getByText(/1 undeclared tool/)).toBeInTheDocument();
    expect(screen.getByText(/not an advertised tool/)).toBeInTheDocument();
  });

  it("flags partial readiness when the tool inventory was unavailable", () => {
    render(
      <SessionInsightBar
        readiness={ready({
          status: "partial",
          coverageRatio: undefined,
          advertisedToolsKnown: false,
        })}
      />
    );
    expect(screen.getByText(/tool inventory unavailable/)).toBeInTheDocument();
  });

  it("shows a progress state while pending", () => {
    render(<SessionInsightBar readiness={ready({ status: "pending" })} />);
    expect(screen.getByText(/in progress/i)).toBeInTheDocument();
  });

  it("surfaces the error on a failed analysis", () => {
    render(
      <SessionInsightBar
        readiness={ready({
          status: "failed",
          errorMessage: "trace unreadable",
        })}
      />
    );
    expect(screen.getByText(/Readiness analysis failed/i)).toBeInTheDocument();
    expect(screen.getByText(/trace unreadable/)).toBeInTheDocument();
  });
});
