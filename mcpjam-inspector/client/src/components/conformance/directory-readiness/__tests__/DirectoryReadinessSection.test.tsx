/**
 * The readiness section, and the four things it must never say.
 *
 *   1. A run that FAILED is not a grade. "Not ready" is a statement about
 *      somebody's server; a runner that fell over has not made one.
 *   2. A refused AI observation is not a failure. The deterministic grade is
 *      complete without it, and `billing_limit_reached` means "we could not
 *      afford to look", never "we looked and it was fine".
 *   3. A lane's coverage travels with its verdict, so a lane graded over three
 *      of eight requirements cannot read like one graded over eight.
 *   4. A package submission mode is offered but disabled, with the reason —
 *      a shorter menu would leave a submitter thinking readiness cannot grade
 *      their plugin at all.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const mockRunLocal = vi.fn();
const mockStartHosted = vi.fn();
const mockGetRun = vi.fn();
const mockGetReport = vi.fn();
const mockCancel = vi.fn();
const mockFindLatest = vi.fn();
const mockIsHosted = vi.fn(() => false);

vi.mock("@/lib/apis/directory-readiness-api", async () => {
  const actual = await vi.importActual<
    typeof import("@/lib/apis/directory-readiness-api")
  >("@/lib/apis/directory-readiness-api");
  return {
    ...actual,
    runLocalReadiness: (...args: unknown[]) => mockRunLocal(...args),
    startHostedReadiness: (...args: unknown[]) => mockStartHosted(...args),
    getHostedReadinessRun: (...args: unknown[]) => mockGetRun(...args),
    getHostedReadinessReport: (...args: unknown[]) => mockGetReport(...args),
    cancelHostedReadinessRun: (...args: unknown[]) => mockCancel(...args),
    findLatestHostedReadinessRun: (...args: unknown[]) =>
      mockFindLatest(...args),
    canRunHostedReadiness: () => true,
  };
});

vi.mock("@/lib/apis/mode-client", () => ({
  isHostedMode: () => mockIsHosted(),
  runByMode: (arg: { local: () => unknown }) => arg.local(),
}));

import { DirectoryReadinessSection } from "../DirectoryReadinessSection";

const HTTP_SERVER = {
  name: "demo",
  config: { url: new URL("https://demo.example.com/mcp") },
};

const STDIO_SERVER = {
  name: "local-demo",
  config: { command: "node", args: ["server.js"] },
};

function claudeResult(overrides: Record<string, unknown> = {}) {
  return {
    status: "not-ready",
    summary: "runtime-compatibility has unmet requirements.",
    context: { target: "https://demo.example.com/mcp" },
    lanes: [
      {
        lane: "runtime-compatibility",
        status: "not-ready",
        coverage: {
          lane: "runtime-compatibility",
          evaluated: 3,
          notEvaluated: 5,
          notApplicable: 0,
          missingInputs: ["toolListing"],
        },
      },
    ],
    findings: [
      {
        id: "claude.auth.prm",
        title: "Protected Resource Metadata is discoverable",
        lane: "runtime-compatibility",
        class: "required",
        status: "violated",
        remediation: "Publish a PRM document.",
      },
      {
        id: "claude.experience.overlap",
        title: "Two tools appear to cover the same job",
        lane: "experience-insights",
        class: "heuristic",
        status: "informational",
        provenance: "llm",
      },
    ],
    badges: [],
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockIsHosted.mockReturnValue(false);
  mockFindLatest.mockResolvedValue(null);
});

describe("local mode", () => {
  it("grades inline and groups findings by what they cost", async () => {
    mockRunLocal.mockResolvedValue({ success: true, result: claudeResult() });
    render(
      <DirectoryReadinessSection publisher="claude" server={HTTP_SERVER} />,
    );

    await userEvent.click(
      screen.getByRole("button", { name: /run readiness/i }),
    );

    await waitFor(() => {
      expect(screen.getByText(/Directory requirements/i)).toBeInTheDocument();
    });
    // The class decides whether a finding moved the verdict, so a reader has
    // to be able to tell a requirement from an opinion.
    expect(screen.getByText(/Observations/i)).toBeInTheDocument();
    expect(screen.getByText(/Not ready/i)).toBeInTheDocument();
  });

  it("shows what a lane could not evaluate, beside its verdict", async () => {
    mockRunLocal.mockResolvedValue({ success: true, result: claudeResult() });
    render(
      <DirectoryReadinessSection publisher="claude" server={HTTP_SERVER} />,
    );

    await userEvent.click(
      screen.getByRole("button", { name: /run readiness/i }),
    );

    await waitFor(() => {
      expect(screen.getByText(/3\/8 evaluated/)).toBeInTheDocument();
    });
    expect(
      screen.getByText(/Supply toolListing to close this gap/i),
    ).toBeInTheDocument();
  });

  it("offers no AI toggle at all, because a local run cannot spend", () => {
    render(
      <DirectoryReadinessSection publisher="claude" server={HTTP_SERVER} />,
    );
    expect(screen.queryByText(/uses MCPJam credits/i)).not.toBeInTheDocument();
  });
});

describe("a server this cannot grade", () => {
  it("says so instead of dialling and reading a 400", () => {
    render(
      <DirectoryReadinessSection publisher="claude" server={STDIO_SERVER} />,
    );
    expect(screen.getByText(/Unavailable/i)).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /run readiness/i }),
    ).not.toBeInTheDocument();
  });
});

describe("hosted mode", () => {
  beforeEach(() => {
    mockIsHosted.mockReturnValue(true);
  });

  it("reports a failed RUN as a failed run, never as a verdict", async () => {
    mockStartHosted.mockResolvedValue({
      runId: "run_1",
      status: "pending",
      deduped: false,
      includeLlmObservations: false,
      readinessKind: "claude",
      projectId: "p",
      serverId: "s",
    });
    mockGetRun.mockResolvedValue({
      id: "run_1",
      status: "failed",
      overallStatus: null,
      lanes: [],
      stages: [],
      terminalReason: "deadline_exceeded",
      errorMessage: null,
      hasReport: false,
      llmObservations: { status: "not-requested" },
      includeLlmObservations: false,
    });

    render(
      <DirectoryReadinessSection publisher="claude" server={HTTP_SERVER} />,
    );
    await userEvent.click(
      screen.getByRole("button", { name: /run readiness/i }),
    );

    await waitFor(() => {
      expect(screen.getByText(/Run failed/i)).toBeInTheDocument();
    });
    // The distinction the product exists for: our runner falling over is not
    // a finding about somebody else's server.
    expect(screen.queryByText(/Not ready/i)).not.toBeInTheDocument();
    expect(screen.getByText(/deadline_exceeded/)).toBeInTheDocument();
  });

  it("reports a refused observation as a gap, not a failure", async () => {
    mockStartHosted.mockResolvedValue({
      runId: "run_2",
      status: "pending",
      deduped: false,
      includeLlmObservations: true,
      readinessKind: "claude",
      projectId: "p",
      serverId: "s",
    });
    mockGetRun.mockResolvedValue({
      id: "run_2",
      status: "completed",
      overallStatus: "ready",
      lanes: [],
      stages: [],
      terminalReason: null,
      errorMessage: null,
      hasReport: true,
      llmObservations: {
        status: "billing-blocked",
        reason: "billing_limit_reached",
      },
      includeLlmObservations: true,
    });
    mockGetReport.mockResolvedValue(claudeResult({ status: "ready" }));

    render(
      <DirectoryReadinessSection publisher="claude" server={HTTP_SERVER} />,
    );
    await userEvent.click(
      screen.getByRole("button", { name: /run readiness/i }),
    );

    await waitFor(() => {
      expect(
        screen.getByText(/reached its MCPJam model limit/i),
      ).toBeInTheDocument();
    });
    // The grade stands on its own; the missing paid pass does not demote it.
    expect(
      screen.getByText(/The grade below is complete without them/i),
    ).toBeInTheDocument();
    expect(screen.getByText(/^Ready$/i)).toBeInTheDocument();
  });

  it("offers the package modes disabled, with the surface that can run them", () => {
    render(
      <DirectoryReadinessSection publisher="openai" server={HTTP_SERVER} />,
    );
    const packageOption = screen.getByRole("option", {
      name: /Skills package only/i,
    }) as HTMLOptionElement;
    expect(packageOption.disabled).toBe(true);
    expect(packageOption.textContent).toMatch(/mcpjam readiness check/i);
  });
});
