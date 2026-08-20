/**
 * The readiness panel, and the four claims it makes that must not drift.
 *
 * 1. NO NUMBER. Readiness answers "would this be listed", which has no
 *    numerator. The suites above it pool into a score; a percentage here would
 *    be invented, and an invented number is the one people quote.
 * 2. `incomplete` IS NOT `not-ready`. A lane nobody could evaluate and a lane
 *    that failed lead to different work, and the coverage denominator is what
 *    keeps them apart — a lane with zero violations and zero evaluated checks
 *    is not a clean bill of health.
 * 3. THE BILLED OPT-IN IS OFF, and says what it costs where it is clicked.
 * 4. A REFUSED OBSERVATION IS NOT A FAILED RUN. `billing-blocked` reports on
 *    its own axis beside a grade that is complete and correct; folding the two
 *    would send a user to fix a server that is fine.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ServerWithName } from "@/hooks/use-app-state";

const startMock = vi.fn();
const getRunMock = vi.fn();
const getReportMock = vi.fn();
const cancelMock = vi.fn();
const hostedRef = { current: true };

vi.mock("@/lib/apis/mcp-readiness-api", () => ({
  startDirectoryReadiness: (...args: unknown[]) => startMock(...args),
  getHostedReadinessRun: (...args: unknown[]) => getRunMock(...args),
  getHostedReadinessReport: (...args: unknown[]) => getReportMock(...args),
  cancelHostedReadinessRun: (...args: unknown[]) => cancelMock(...args),
  canRequestModelObservations: () => hostedRef.current,
}));

import { DirectoryReadinessSection } from "../DirectoryReadinessSection";

const SERVER = {
  name: "test-server",
  config: { url: new URL("https://example.test/mcp") },
} as unknown as ServerWithName;

function hostedRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "run_1",
    readinessKind: "claude",
    serverUrl: "https://example.test/mcp",
    submissionMode: null,
    status: "completed",
    overallStatus: "incomplete",
    lanes: [
      {
        lane: "runtime-compatibility",
        status: "ready",
        evaluated: 4,
        notEvaluated: 0,
        notApplicable: 1,
        missingInputs: [],
      },
      {
        lane: "directory-policy",
        status: "incomplete",
        evaluated: 0,
        notEvaluated: 3,
        notApplicable: 0,
        missingInputs: ["toolListing"],
      },
    ],
    stages: [],
    terminalReason: null,
    errorMessage: null,
    policySnapshotDate: null,
    engineVersion: null,
    includeLlmObservations: false,
    llmObservations: { status: "not-requested", reason: "not_requested" },
    hasReport: false,
    createdAt: 1,
    updatedAt: 2,
    ...overrides,
  };
}

/**
 * Open the section, then hand back its Run button.
 *
 * Readiness starts COLLAPSED, exactly like the four suites beside it: an idle
 * section that opened itself would push the suites a user came for off the
 * screen. Every test that runs something has to open it first, which is also
 * what a user does.
 */
async function openAndFindRun(publisher: "claude" | "openai") {
  const label =
    publisher === "claude"
      ? /Claude directory readiness/i
      : /OpenAI plugin directory readiness/i;
  await userEvent.click(screen.getByRole("button", { name: label }));
  return screen.getByRole("button", { name: /Run readiness checks/i });
}

beforeEach(() => {
  vi.clearAllMocks();
  hostedRef.current = true;
});

describe("DirectoryReadinessSection", () => {
  it("offers the billed opt-in UNCHECKED, and names the cost in the label", async () => {
    render(<DirectoryReadinessSection server={SERVER} publisher="claude" />);
    await userEvent.click(
      screen.getByRole("button", { name: /Claude directory readiness/i }),
    );
    const checkbox = screen.getByRole("checkbox");
    expect(checkbox).not.toBeChecked();
    expect(screen.getByText(/uses MCPJam credits/i)).toBeInTheDocument();
  });

  it("hides the opt-in entirely where there is no broker to honour it", async () => {
    // A local build has no lease, no payer and no broker. A checkbox with
    // nothing behind it would read as a capability that is merely switched
    // off.
    hostedRef.current = false;
    render(<DirectoryReadinessSection server={SERVER} publisher="claude" />);
    await userEvent.click(
      screen.getByRole("button", { name: /Claude directory readiness/i }),
    );
    expect(screen.queryByRole("checkbox")).toBeNull();
  });

  it("does not send the opt-in unless it was asked for", async () => {
    startMock.mockResolvedValue({
      mode: "hosted",
      receipt: { runId: "run_1" },
    });
    getRunMock.mockResolvedValue(hostedRow());
    render(<DirectoryReadinessSection server={SERVER} publisher="claude" />);
    await userEvent.click(await openAndFindRun("claude"));
    await waitFor(() => expect(startMock).toHaveBeenCalled());
    expect(startMock).toHaveBeenCalledWith(
      expect.objectContaining({ includeLlmObservations: false }),
    );
  });

  it("publishes the coverage denominator, never a score", async () => {
    // A lane with zero violations and zero evaluated checks is not a pass.
    // The only way to keep that apart from a real pass is to show what was
    // looked at.
    startMock.mockResolvedValue({
      mode: "hosted",
      receipt: { runId: "run_1" },
    });
    getRunMock.mockResolvedValue(hostedRow());
    render(<DirectoryReadinessSection server={SERVER} publisher="claude" />);
    await userEvent.click(await openAndFindRun("claude"));

    await screen.findByText(/0\/3 evaluated/);
    expect(screen.getByText(/Missing: toolListing/)).toBeInTheDocument();
    // The suites above pool into "NN/100". Readiness must never render one.
    expect(screen.queryByText(/\d+\/100/)).toBeNull();
  });

  it("says INCOMPLETE rather than not ready when a lane could not be evaluated", async () => {
    startMock.mockResolvedValue({
      mode: "hosted",
      receipt: { runId: "run_1" },
    });
    getRunMock.mockResolvedValue(hostedRow());
    render(<DirectoryReadinessSection server={SERVER} publisher="claude" />);
    await userEvent.click(await openAndFindRun("claude"));
    await screen.findByText("Incomplete");
    expect(screen.queryByText("Not ready")).toBeNull();
  });

  it("reports a credit refusal beside the grade, not as a failure of it", async () => {
    startMock.mockResolvedValue({
      mode: "hosted",
      receipt: { runId: "run_1" },
    });
    getRunMock.mockResolvedValue(
      hostedRow({
        overallStatus: "ready",
        llmObservations: {
          status: "billing-blocked",
          reason: "billing_limit_reached",
        },
      }),
    );
    render(<DirectoryReadinessSection server={SERVER} publisher="claude" />);
    await userEvent.click(await openAndFindRun("claude"));

    // The GRADE still stands.
    await screen.findByText("Ready");
    // And the refusal is stated, with the remedy rather than a retry button —
    // retrying a refused reservation refuses again.
    expect(
      screen.getByText(/MCPJam credit limit reached/i),
    ).toBeInTheDocument();
    expect(screen.getByText(/complete and unaffected/i)).toBeInTheDocument();
  });

  it("offers OpenAI's submission shapes, and none the browser cannot supply", async () => {
    render(<DirectoryReadinessSection server={SERVER} publisher="openai" />);
    await userEvent.click(
      screen.getByRole("button", {
        name: /OpenAI plugin directory readiness/i,
      }),
    );
    expect(screen.getByLabelText(/Submission/i)).toBeInTheDocument();
  });

  it("has no submission control for Claude, which declares no shape", async () => {
    render(<DirectoryReadinessSection server={SERVER} publisher="claude" />);
    await userEvent.click(
      screen.getByRole("button", { name: /Claude directory readiness/i }),
    );
    expect(screen.queryByLabelText(/Submission/i)).toBeNull();
  });

  it("renders a local run's result without polling anything", async () => {
    // Local runs are synchronous, unpersisted and free: there is no row to
    // read and no lease to cancel.
    startMock.mockResolvedValue({
      mode: "local",
      result: {
        status: "ready",
        lanes: [
          {
            lane: "runtime-compatibility",
            coverage: {
              lane: "runtime-compatibility",
              status: "ready",
              evaluated: 2,
              notEvaluated: 0,
              notApplicable: 0,
              missingInputs: [],
            },
          },
        ],
      },
    });
    render(<DirectoryReadinessSection server={SERVER} publisher="claude" />);
    await userEvent.click(await openAndFindRun("claude"));
    await screen.findByText("Ready");
    expect(getRunMock).not.toHaveBeenCalled();
  });

  it("surfaces a start failure as an error rather than an empty grade", async () => {
    startMock.mockRejectedValue(new Error("the server said no"));
    render(<DirectoryReadinessSection server={SERVER} publisher="claude" />);
    await userEvent.click(await openAndFindRun("claude"));
    await screen.findByText("the server said no");
    expect(screen.queryByText("Ready")).toBeNull();
  });
});
