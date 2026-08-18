import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
  buildReadinessDetailLines,
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

  it("hides the badge for ready sessions", () => {
    const { container } = render(
      <SessionReadinessBadge readiness={ready()} />
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("shows a spinner while pending", () => {
    render(<SessionReadinessBadge readiness={ready({ status: "pending" })} />);
    expect(screen.getByLabelText(/analyzing readiness/i)).toBeInTheDocument();
  });

  it("shows a verdict dot with an accessible label", () => {
    render(
      <SessionReadinessBadge
        readiness={ready({ verdict: "not_ready", issueCount: 2 })}
      />
    );
    expect(
      screen.getByLabelText(/Not ready, 2 issues/i)
    ).toBeInTheDocument();
  });

  it("shows a distinct failed state", () => {
    render(<SessionReadinessBadge readiness={ready({ status: "failed" })} />);
    expect(
      screen.getByLabelText(/Readiness analysis failed/i)
    ).toBeInTheDocument();
  });
});

describe("SessionInsightBar", () => {
  it("hides the bar for ready sessions", () => {
    const { container } = render(<SessionInsightBar readiness={ready()} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("surfaces the primary finding and detail trigger", () => {
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
    expect(
      screen.getByText(/not an advertised tool/i)
    ).toBeInTheDocument();
    expect(screen.getByLabelText(/Readiness details/i)).toBeInTheDocument();
    expect(buildReadinessDetailLines(ready({
      verdict: "not_ready",
      issueCount: 1,
      toolErrorCount: 2,
      toolCallCount: 4,
      hallucinatedTools: ["made_up_tool"],
      issues: [
        {
          code: "hallucinated_tool",
          severity: "error",
          message: 'Called "made_up_tool", which is not an advertised tool.',
          toolName: "made_up_tool",
        },
      ],
    }))).toEqual(
      expect.arrayContaining([
        "Not ready",
        "2/4 tool calls failed",
        "1 undeclared tool",
      ]),
    );
  });

  it("puts host-response latency in the detail tooltip copy", () => {
    expect(
      buildReadinessDetailLines(
        ready({ verdict: "needs_attention", hostLatencyMs: 3500 }),
      ),
    ).toContain("3.5s client latency");
  });

  it("flags partial readiness when the tool inventory was unavailable", () => {
    render(
      <SessionInsightBar
        readiness={ready({
          status: "partial",
          verdict: "needs_attention",
          coverageRatio: undefined,
          advertisedToolsKnown: false,
        })}
      />
    );
    expect(
      screen.getByText(/tool inventory was unavailable/i)
    ).toBeInTheDocument();
  });

  it("shows a progress state while pending", () => {
    render(<SessionInsightBar readiness={ready({ status: "pending" })} />);
    expect(screen.getByText(/Analyzing readiness/i)).toBeInTheDocument();
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
    expect(screen.getByText(/Readiness unavailable/i)).toBeInTheDocument();
    expect(screen.getByText(/trace unreadable/)).toBeInTheDocument();
  });

  it("explains low tool coverage when issues are omitted", () => {
    render(
      <SessionInsightBar
        readiness={ready({
          verdict: "needs_attention",
          issueCount: 1,
          coverageRatio: 0.2,
          advertisedToolCount: 5,
          usedToolCount: 1,
          issues: [],
        })}
      />
    );
    expect(
      screen.getByText(/Only 20% of advertised tools were used/i),
    ).toBeInTheDocument();
  });

  it("explains when no tools were called on a tool-enabled swarm", () => {
    render(
      <SessionInsightBar
        readiness={ready({
          verdict: "needs_attention",
          issueCount: 1,
          advertisedToolCount: 4,
          usedToolCount: 0,
          toolCallCount: 0,
          issues: [],
        })}
      />
    );
    expect(
      screen.getByText(/No tools were called, but 4 tools are advertised/i),
    ).toBeInTheDocument();
  });
});
