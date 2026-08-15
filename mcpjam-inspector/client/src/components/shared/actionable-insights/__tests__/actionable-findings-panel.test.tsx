import { render, screen, fireEvent } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ActionableFindingsPanel } from "../actionable-findings-panel";
import type {
  ActionableFinding,
  InsightsEnvelope,
} from "@/lib/insights-envelope-api";

const copied = vi.hoisted(() => ({ text: "" }));
vi.mock("@/lib/clipboard", () => ({
  copyToClipboard: async (text: string) => {
    copied.text = text;
    return true;
  },
}));

function finding(
  overrides: Partial<ActionableFinding> = {},
): ActionableFinding {
  return {
    id: "rf_1",
    signalFingerprint: "tool_errors:tool:create_event",
    title: "create_event rejects natural-language dates",
    category: "tool_contract",
    attribution: "server_contract",
    actionTarget: "mcp_server",
    actionability: "ready",
    severity: "high",
    confidence: "high",
    observed: '"create_event" failed 5× across 3 of 8 sessions',
    recommendation: "Add format guidance to the date field.",
    acceptanceCriteria: ["The error signature does not recur."],
    affected: { count: 3, total: 8, unit: "sessions" },
    target: {
      serverId: "srv_cal",
      toolName: "create_event",
      surface: "input_schema",
      fieldPath: "properties.date",
      snapshotHash: "sha256:abc",
      currentDefinition: {
        description: "Create an event.",
        inputSchemaJson: '{"properties":{"date":{}}}',
        truncated: false,
      },
    },
    evidence: [
      {
        sessionId: "ses_a1",
        kind: "tool_error",
        toolName: "create_event",
        excerpt: "Invalid params: date must match ISO-8601",
      },
    ],
    ...overrides,
  };
}

function envelope(overrides: Partial<InsightsEnvelope> = {}): InsightsEnvelope {
  return {
    schemaVersion: 1,
    scope: { kind: "eval_run", id: "run_1" },
    status: "completed",
    reasonCode: null,
    retryable: false,
    error: null,
    generatedAt: 1,
    updatedAt: 1,
    summary: "One tool keeps failing.",
    coverage: {
      unit: "sessions",
      analyzed: 8,
      total: 8,
      truncated: false,
      lowConfidence: false,
    },
    findings: [finding()],
    truncation: {
      truncated: false,
      omittedFindings: 0,
      omittedEvidence: 0,
      contractTruncated: false,
    },
    ...overrides,
  };
}

describe("ownership and affordances", () => {
  it("renders a ready server finding under a server heading with its contract", () => {
    render(<ActionableFindingsPanel envelope={envelope()} />);
    expect(screen.getByText("Fix in your MCP server")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("actionable-finding-headline"));
    expect(screen.getByTestId("actionable-finding-contract")).toHaveTextContent(
      "sha256:abc",
    );
    expect(screen.getByTestId("finding-copy-prompt")).toHaveTextContent(
      "Copy server fix prompt",
    );
  });

  it("withholds the pinned contract from an UNPROVEN server finding", () => {
    // The contract next to an unproven claim reads as "here is the code to
    // change" — the gate withheld readiness, so the UI withholds the target.
    render(
      <ActionableFindingsPanel
        envelope={envelope({
          findings: [finding({ actionability: "investigate" })],
        })}
      />,
    );
    expect(screen.getByText("Suspected server issues")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("actionable-finding-headline"));
    expect(
      screen.queryByTestId("actionable-finding-contract"),
    ).not.toBeInTheDocument();
    expect(screen.getByTestId("finding-copy-prompt")).toHaveTextContent(
      "Copy investigation prompt",
    );
  });

  it("never offers a server-fix prompt for agent or test work", () => {
    for (const [actionTarget, expected] of [
      ["agent_configuration", "Copy agent/prompt fix"],
      ["eval_case", "Copy test fix"],
    ] as const) {
      const { unmount } = render(
        <ActionableFindingsPanel
          envelope={envelope({
            findings: [
              finding({
                actionTarget,
                actionability: "investigate",
                target: undefined,
              }),
            ],
          })}
        />,
      );
      fireEvent.click(screen.getByTestId("actionable-finding-headline"));
      const button = screen.getByTestId("finding-copy-prompt");
      expect(button).toHaveTextContent(expected);
      expect(button).toHaveAttribute("data-server-fix", "false");
      unmount();
    }
  });

  it("gives environment rows no prompt at all", () => {
    render(
      <ActionableFindingsPanel
        envelope={envelope({
          findings: [
            finding({
              actionTarget: "environment",
              actionability: "informational",
              target: undefined,
            }),
          ],
        })}
      />,
    );
    fireEvent.click(screen.getByTestId("actionable-finding-headline"));
    expect(screen.queryByTestId("finding-copy-prompt")).not.toBeInTheDocument();
  });

  it("copies the prompt matching the finding's ownership", () => {
    render(<ActionableFindingsPanel envelope={envelope()} />);
    fireEvent.click(screen.getByTestId("actionable-finding-headline"));
    fireEvent.click(screen.getByTestId("finding-copy-prompt"));
    expect(copied.text).toContain("Fix a defect in the MCP server");
    expect(copied.text).toContain("sha256:abc");
    expect(copied.text).toContain("UNTRUSTED");
  });
});

describe("ordering", () => {
  it("puts ready server fixes above every other kind of work", () => {
    render(
      <ActionableFindingsPanel
        envelope={envelope({
          findings: [
            finding({
              id: "rf_env",
              actionTarget: "environment",
              actionability: "informational",
              target: undefined,
            }),
            finding({
              id: "rf_agent",
              actionTarget: "agent_configuration",
              actionability: "investigate",
              target: undefined,
            }),
            finding({ id: "rf_ready" }),
          ],
        })}
      />,
    );
    const rows = screen.getAllByTestId("actionable-finding");
    expect(rows[0]).toHaveAttribute("data-actionability", "ready");
  });

  it("ranks investigations above environment rows, matching the sections", () => {
    // These disagreed: environment sorted higher but rendered lower, so with
    // more findings than fit, environment rows survived the cut over
    // investigations and still appeared last.
    render(
      <ActionableFindingsPanel
        envelope={envelope({
          findings: [
            finding({
              id: "rf_env",
              actionTarget: "environment",
              actionability: "informational",
              target: undefined,
            }),
            finding({
              id: "rf_investigate",
              actionTarget: "investigate",
              actionability: "investigate",
              target: undefined,
            }),
          ],
        })}
      />,
    );
    const rows = screen.getAllByTestId("actionable-finding");
    expect(rows[0]).toHaveAttribute("data-action-target", "investigate");
  });

  it("never titles a section 'fix your MCP server' over non-server work", () => {
    render(
      <ActionableFindingsPanel
        envelope={envelope({
          findings: [
            finding({
              actionTarget: "agent_configuration",
              actionability: "investigate",
              target: undefined,
            }),
          ],
        })}
      />,
    );
    expect(
      screen.queryByText("Fix in your MCP server"),
    ).not.toBeInTheDocument();
    expect(screen.getByText("Agent and prompt")).toBeInTheDocument();
  });
});

describe("lifecycle states", () => {
  it("renders nothing at all when there is no envelope (older backend)", () => {
    const { container } = render(
      <ActionableFindingsPanel envelope={undefined} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it.each([
    ["pending", /Analyzing/i],
    ["not_requested", /No analysis has been requested/i],
    ["not_available", /once this finishes/i],
  ] as const)(
    "explains the %s state instead of showing an empty list",
    (status, copy) => {
      const { unmount } = render(
        <ActionableFindingsPanel
          envelope={envelope({ status, findings: [] })}
        />,
      );
      expect(
        screen.getByTestId("actionable-findings-status"),
      ).toHaveTextContent(copy);
      unmount();
    },
  );

  it("surfaces a failure with its message and retryability", () => {
    render(
      <ActionableFindingsPanel
        envelope={envelope({
          status: "failed",
          findings: [],
          retryable: true,
          error: { code: "spend_cap_exceeded", message: "Cap reached." },
        })}
      />,
    );
    expect(screen.getByTestId("actionable-findings-status")).toHaveTextContent(
      /Cap reached\..*request it again/i,
    );
  });

  it("distinguishes a clean result from an incomplete one", () => {
    const { unmount } = render(
      <ActionableFindingsPanel envelope={envelope({ findings: [] })} />,
    );
    expect(screen.getByTestId("actionable-findings-empty")).toHaveTextContent(
      /Nothing here needs a change/i,
    );
    unmount();

    render(
      <ActionableFindingsPanel
        envelope={envelope({
          findings: [],
          coverage: { ...envelope().coverage, truncated: true },
        })}
      />,
    );
    expect(screen.getByTestId("actionable-findings-empty")).toHaveTextContent(
      /did not see everything/i,
    );
  });

  it("describes a contract-only clip without claiming findings were dropped", () => {
    render(
      <ActionableFindingsPanel
        envelope={envelope({
          truncation: {
            truncated: true,
            omittedFindings: 0,
            omittedEvidence: 0,
            contractTruncated: true,
          },
        })}
      />,
    );
    expect(
      screen.getByText(/tool definition was shortened/i),
    ).toBeInTheDocument();
    expect(screen.queryByText(/0 findings/)).not.toBeInTheDocument();
  });

  it("reports omissions when the payload was compacted", () => {
    render(
      <ActionableFindingsPanel
        envelope={envelope({
          truncation: {
            truncated: true,
            omittedFindings: 2,
            omittedEvidence: 3,
            contractTruncated: false,
          },
        })}
      />,
    );
    expect(
      screen.getByText(/2 findings, 3 evidence records/),
    ).toBeInTheDocument();
  });
});

describe("evidence", () => {
  it("links a session when the surface can open one", () => {
    const onOpenSession = vi.fn();
    render(
      <ActionableFindingsPanel
        envelope={envelope()}
        onOpenSession={onOpenSession}
      />,
    );
    fireEvent.click(screen.getByTestId("actionable-finding-headline"));
    fireEvent.click(screen.getByTestId("actionable-finding-session-link"));
    expect(onOpenSession).toHaveBeenCalledWith("ses_a1");
  });

  it("keeps the deterministic observation visible without expanding", () => {
    render(<ActionableFindingsPanel envelope={envelope()} />);
    expect(screen.getByTestId("actionable-finding-observed")).toHaveTextContent(
      "failed 5× across 3 of 8 sessions",
    );
  });
});
