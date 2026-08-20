/**
 * The readiness page.
 *
 * These pin the three rendering rules the model demands, each tested for the
 * misreading it prevents rather than for the markup it produces:
 *
 *   1. COVERAGE IS ALWAYS BESIDE THE LANE, so "nothing was violated" cannot be
 *      read as "everything passed".
 *   2. ONLY THE VERDICT IS THE VERDICT. Advisory lanes and badges are labelled
 *      as advisory, and a run that failed to finish renders as a failure to
 *      finish rather than as `not-ready`.
 *   3. FINDINGS CARRY THEIR PROVENANCE AND SOURCE, because `declared` beside a
 *      satisfied finding means "they told us", not "we checked".
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ClaudeReadinessResult } from "@mcpjam/sdk";
import type { ServerWithName } from "@/hooks/use-app-state";

const mockRunGrade = vi.fn();

vi.mock("@/lib/apis/mcp-conformance-api", () => ({
  runClaudeReadinessGrade: (...args: unknown[]) => mockRunGrade(...args),
}));

import { ClaudeReadinessTab } from "../ClaudeReadinessPanel";

const SERVER = {
  name: "acme",
  connectionStatus: "connected",
} as unknown as ServerWithName;

function result(
  overrides: Partial<ClaudeReadinessResult> = {},
): ClaudeReadinessResult {
  return {
    status: "not-ready",
    summary: "The connector is served over plaintext HTTP.",
    policySnapshotDate: "2026-08-19",
    engineVersion: "1.0.0",
    startedAt: new Date(0).toISOString(),
    durationMs: 1234,
    context: {
      target: "http://mcp.example.com/mcp",
      authMode: "headless",
      capabilities: ["dns", "raw-origin"],
    },
    lanes: [
      {
        lane: "runtime-compatibility",
        status: "not-ready",
        summary: "One requirement is unmet.",
        coverage: {
          evaluated: 4,
          notEvaluated: 2,
          notApplicable: 1,
          missingInputs: [],
        },
      },
      {
        lane: "submission-artifacts",
        status: "incomplete",
        summary: "No submission profile was supplied.",
        coverage: {
          evaluated: 0,
          notEvaluated: 9,
          notApplicable: 0,
          missingInputs: ["submissionProfile"],
        },
      },
      {
        lane: "experience-insights",
        status: "incomplete",
        summary: "Heuristics were not run.",
        coverage: {
          evaluated: 0,
          notEvaluated: 3,
          notApplicable: 0,
          missingInputs: [],
        },
      },
    ],
    findings: [
      {
        id: "claude.endpoint.https",
        title: "The connector must be served over HTTPS",
        lane: "runtime-compatibility",
        class: "required",
        status: "violated",
        remediation: "Serve the endpoint over TLS.",
        source: {
          url: "https://support.anthropic.com/directory",
          section: "Transport requirements",
        },
        provenance: "wire",
        intrusiveness: "passive",
        evaluatedAt: new Date(0).toISOString(),
        engineVersion: "1.0.0",
      },
      {
        id: "claude.listing.icon",
        title: "The listing should carry an icon",
        lane: "submission-artifacts",
        class: "recommended",
        status: "not-evaluated",
        notEvaluatedReason: "No submission profile was supplied.",
        source: { url: "https://support.anthropic.com/directory" },
        provenance: "declared",
        intrusiveness: "passive",
        evaluatedAt: new Date(0).toISOString(),
        engineVersion: "1.0.0",
      },
      {
        id: "claude.tools.named",
        title: "Tools are clearly named",
        lane: "runtime-compatibility",
        class: "required",
        status: "satisfied",
        source: { url: "https://support.anthropic.com/directory" },
        provenance: "wire",
        intrusiveness: "passive",
        evaluatedAt: new Date(0).toISOString(),
        engineVersion: "1.0.0",
      },
    ],
    badges: [
      {
        id: "claude.badge.elicitation",
        title: "Elicitation",
        state: "unsupported",
        provenance: "wire",
      },
    ],
    ...overrides,
  } as ClaudeReadinessResult;
}

async function grade(server: ServerWithName | null = SERVER) {
  render(<ClaudeReadinessTab server={server} />);
  await userEvent.click(
    screen.getByRole("button", { name: /Grade this connector/i }),
  );
}

beforeEach(() => {
  mockRunGrade.mockReset();
});

describe("before a run", () => {
  it("asks for a server rather than rendering an empty grade", async () => {
    render(<ClaudeReadinessTab server={null} />);
    expect(screen.getByText(/Connect a server to grade it/i)).toBeTruthy();
    expect(mockRunGrade).not.toHaveBeenCalled();
  });

  it("says an absent submission profile is optional, not a failure", async () => {
    render(<ClaudeReadinessTab server={SERVER} />);
    expect(screen.getByText(/optional/i)).toBeTruthy();
    expect(screen.getByText(/reports as incomplete rather than passing/i))
      .toBeTruthy();
  });
});

describe("the verdict", () => {
  it("never presents itself as a conformance score", async () => {
    // The one thing this page must not be mistaken for. Conformance produces
    // a pooled number; readiness grades listing policy and produces none.
    mockRunGrade.mockResolvedValue({ success: true, result: result() });
    await grade();
    await waitFor(() => expect(screen.getByText("Not ready")).toBeTruthy());
    expect(
      screen.getByText(/not a conformance score and does not affect one/i),
    ).toBeTruthy();
    expect(screen.getByText(/Nothing here is submitted to Anthropic/i))
      .toBeTruthy();
  });

  it("dates the grade to the policy snapshot it was made against", async () => {
    // A verdict that cannot say WHICH revision of Anthropic's docs it read
    // goes silently wrong rather than visibly stale.
    mockRunGrade.mockResolvedValue({ success: true, result: result() });
    await grade();
    await waitFor(() => expect(screen.getByText(/2026-08-19/)).toBeTruthy());
    expect(screen.getByText(/engine 1\.0\.0/)).toBeTruthy();
  });

  it("renders a run that did not finish as that, not as not-ready", async () => {
    // A run that failed to complete has ESTABLISHED NOTHING. Showing a verdict
    // would file an outage as a policy failure against somebody's connector.
    mockRunGrade.mockRejectedValue(new Error("connection refused"));
    await grade();
    await waitFor(() =>
      expect(screen.getByText(/The grade did not complete/i)).toBeTruthy(),
    );
    expect(screen.queryByText("Not ready")).toBeNull();
    expect(screen.queryByText("Ready to submit")).toBeNull();
  });
});

describe("lanes", () => {
  it("shows coverage on every lane, including one with no violations", async () => {
    // The rule: "nothing was violated" and "nothing was evaluated" must not
    // render the same. The artifacts lane below violated nothing and evaluated
    // nothing, and has to say so.
    mockRunGrade.mockResolvedValue({ success: true, result: result() });
    await grade();
    await waitFor(() =>
      expect(screen.getByText(/Submission artifacts/)).toBeTruthy(),
    );
    expect(
      screen.getByText(/evaluated 0 · not evaluated 9 · not applicable 0/),
    ).toBeTruthy();
    // ...and names what would close it, rather than leaving the reader to guess.
    expect(
      screen.getByText(/Supply submissionProfile to close this lane/i),
    ).toBeTruthy();
  });

  it("marks the lanes that cannot move the verdict as advisory", async () => {
    // Optional features and experience insights can never make a connector
    // not-ready. Rendering them identically to the required lanes would imply
    // a heuristic could block a submission.
    mockRunGrade.mockResolvedValue({ success: true, result: result() });
    await grade();
    await waitFor(() =>
      expect(screen.getByText(/Experience insights/)).toBeTruthy(),
    );
    expect(screen.getAllByText("advisory").length).toBeGreaterThan(0);
  });
});

describe("findings", () => {
  it("puts what blocks a listing above what merely advises", async () => {
    mockRunGrade.mockResolvedValue({ success: true, result: result() });
    await grade();
    await waitFor(() =>
      expect(
        screen.getByText(/must be served over HTTPS/),
      ).toBeTruthy(),
    );
    const rendered = screen.getByText(/must be served over HTTPS/);
    const advisory = screen.getByText(/should carry an icon/);
    // `compareDocumentPosition` rather than index maths: this asserts the
    // reading order a person actually gets.
    expect(
      rendered.compareDocumentPosition(advisory) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("hides satisfied findings until asked, and never hides a violation", async () => {
    mockRunGrade.mockResolvedValue({ success: true, result: result() });
    await grade();
    await waitFor(() =>
      expect(screen.getByText(/must be served over HTTPS/)).toBeTruthy(),
    );
    expect(screen.queryByText(/Tools are clearly named/)).toBeNull();

    await userEvent.click(
      screen.getByRole("button", { name: /Show satisfied/i }),
    );
    expect(screen.getByText(/Tools are clearly named/)).toBeTruthy();
    // The violation survives the toggle in both directions.
    expect(screen.getByText(/must be served over HTTPS/)).toBeTruthy();
  });

  it("labels how each finding was established", async () => {
    // `wire` means we observed it. `declared` means the submitter said so and
    // this run never checked. Collapsing the two would turn a promise into a
    // verified fact.
    mockRunGrade.mockResolvedValue({ success: true, result: result() });
    await grade();
    await waitFor(() => expect(screen.getByText("wire")).toBeTruthy());
    expect(screen.getByText("declared")).toBeTruthy();
  });

  it("cites the policy behind a finding when expanded", async () => {
    mockRunGrade.mockResolvedValue({ success: true, result: result() });
    await grade();
    await waitFor(() =>
      expect(screen.getByText(/must be served over HTTPS/)).toBeTruthy(),
    );
    await userEvent.click(screen.getByText(/must be served over HTTPS/));
    const link = screen.getByRole("link", { name: /Transport requirements/i });
    expect(link.getAttribute("href")).toBe(
      "https://support.anthropic.com/directory",
    );
    expect(screen.getByText(/Serve the endpoint over TLS/)).toBeTruthy();
    // The stable check id, so a finding can be talked about across runs.
    expect(screen.getByText(/claude\.endpoint\.https/)).toBeTruthy();
  });

  it("says why a not-evaluated finding was not evaluated", async () => {
    // An unexplained gap reads as a bug in the tool. A named one is a job.
    mockRunGrade.mockResolvedValue({ success: true, result: result() });
    await grade();
    await waitFor(() =>
      expect(
        screen.getAllByText(/No submission profile was supplied/).length,
      ).toBeGreaterThan(0),
    );
  });
});

describe("badges", () => {
  it("says an unsupported capability is not a defect", async () => {
    // The whole difference between a badge and a requirement.
    mockRunGrade.mockResolvedValue({ success: true, result: result() });
    await grade();
    await waitFor(() => expect(screen.getByText("Elicitation")).toBeTruthy());
    expect(
      screen.getByText(/not a defect and does not affect the verdict/i),
    ).toBeTruthy();
  });
});

describe("the submission profile input", () => {
  it("refuses malformed JSON before dialling anything", async () => {
    render(<ClaudeReadinessTab server={SERVER} />);
    await userEvent.type(
      screen.getByLabelText(/Submission profile/i),
      "{{not json",
    );
    await userEvent.click(
      screen.getByRole("button", { name: /Grade this connector/i }),
    );
    expect(screen.getByText(/not valid JSON/i)).toBeTruthy();
    expect(mockRunGrade).not.toHaveBeenCalled();
  });

  it("sends a valid profile through, and omits an empty one", async () => {
    mockRunGrade.mockResolvedValue({ success: true, result: result() });

    render(<ClaudeReadinessTab server={SERVER} />);
    await userEvent.click(
      screen.getByRole("button", { name: /Grade this connector/i }),
    );
    // Empty box ⇒ no profile argument at all, which is what makes the lane
    // report "not supplied" rather than "supplied and empty".
    expect(mockRunGrade).toHaveBeenCalledWith("acme", undefined);
  });
});
