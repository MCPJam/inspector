import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const stopClimb = vi.fn();
const confirmClimb = vi.fn();
const verifyClimb = vi.fn();
vi.mock("@/lib/apis/climbs-api", () => ({
  stopClimb: (...a: unknown[]) => stopClimb(...a),
  confirmClimb: (...a: unknown[]) => confirmClimb(...a),
  verifyClimb: (...a: unknown[]) => verifyClimb(...a),
}));
vi.mock("../unit-progress", () => ({ UnitProgress: ({ unitKey }: { unitKey?: string }) => <div>progress {unitKey}</div> }));

import { StoppedSummary } from "../stopped-summary";
import { makeClimb, makeRound, makeSummary } from "./fixtures";

const labels = { env_a: "MCPJam · Sonnet", env_b: "Claude Code · Sonnet" };
const change = (summary: string) => ({ target: "tool" as const, kind: "changed" as const, summary, details: [] });
const stoppedResult = (summary = makeSummary()) => ({
  state: "stopped",
  kept: [
    { number: 1, validation: "better", overruled: false },
    { number: 2, validation: "unchanged", overruled: false },
  ],
  prompt: "Change 1: Hide 4 deprecated parameters",
  summary,
});

function show(over: Partial<React.ComponentProps<typeof StoppedSummary>> = {}, climbExtra: object = {}) {
  const props = {
    climb: makeClimb({
      state: "stopped",
      rounds: [makeRound({ number: 1 }), makeRound({ number: 2 })],
      limits: { roundLimit: 10, roundsStarted: 2, roundsLeft: 8, creditLimit: 4000, creditsCommitted: 900, creditsLeft: 3100 },
      groups: { steering: 6, validation: 4, confirmation: 4, steeringCases: [], steeringToolsWithoutValidation: [] },
      ...climbExtra,
    }),
    labels,
    suiteName: "dogfood",
    changes: { 1: [change("Hid 4 parameters")], 2: [change("Rewrote list_projects")] },
    onChanged: vi.fn(),
    onBack: vi.fn(),
    ...over,
  };
  render(<StoppedSummary {...props} />);
  return props;
}

beforeEach(() => {
  [stopClimb, confirmClimb, verifyClimb].forEach((fn) => fn.mockReset());
  confirmClimb.mockResolvedValue({ confirmationCaseCount: 10, estimate: { creditsPerGroup: 90, groups: 2, lowerBound: false }, confirmationCasesUsedBy: [] });
});

describe("StoppedSummary", () => {
  it("shows the results labeled as the cases that picked them, and the changes in two groups", async () => {
    stopClimb.mockResolvedValue(stoppedResult());
    show();
    expect(await screen.findByText("What this climb showed")).toBeInTheDocument();
    expect(screen.getByText("Climb stopped · 2 rounds")).toBeInTheDocument();
    expect(await screen.findByText("78% → 94%")).toBeInTheDocument();
    expect(screen.getByText("Both groups helped pick this result.")).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Validation cases went up too" })).toHaveTextContent("Hid 4 parameters");
    expect(screen.getByRole("region", { name: "Validation cases didn't move" })).toHaveTextContent("Rewrote list_projects");
    await userEvent.click(screen.getByRole("button", { name: "2 kept changes" }));
    expect(screen.getByText("Change 1: Hide 4 deprecated parameters")).toBeInTheDocument();
  });

  it("says why it stopped, and plainly when someone stopped it", async () => {
    stopClimb.mockResolvedValue(stoppedResult(makeSummary({ stoppedBecause: "the round limit was reached" })));
    show({}, { stopReason: "round_limit" });
    expect(await screen.findByText("It stopped because the round limit was reached.")).toBeInTheDocument();
  });

  it("does not repeat itself for a climb stopped on request", async () => {
    stopClimb.mockResolvedValue(stoppedResult(makeSummary({ stoppedBecause: "it was stopped" })));
    show({}, { stopReason: "stopped_by_caller" });
    expect(await screen.findByText("It was stopped on request.")).toBeInTheDocument();
    expect(screen.queryByText(/because it was stopped/)).not.toBeInTheDocument();
  });

  it("offers no verification when no round was kept", async () => {
    stopClimb.mockResolvedValue({ ...stoppedResult(), kept: [], prompt: "" });
    show();
    expect(await screen.findByText("No round was kept, so there is nothing to verify.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Verify" })).not.toBeInTheDocument();
  });

  it("says plainly what a climb established when the suite set no cases aside", async () => {
    stopClimb.mockResolvedValue(stoppedResult(makeSummary({ confirmation: { status: "no_cases", usedByEarlierClimbs: [] } })));
    show({}, { groups: { steering: 6, validation: 4, confirmation: 0, steeringCases: [], steeringToolsWithoutValidation: [] } });
    expect(await screen.findByText("Not confirmed on new cases.")).toBeInTheDocument();
    expect(screen.getByText(/2 rounds improved pass rate\. Both groups helped pick this result\./)).toBeInTheDocument();
    expect(confirmClimb).not.toHaveBeenCalled();
  });

  it("offers the confirmation with its cost, asks first, and runs it once", async () => {
    stopClimb.mockResolvedValue(stoppedResult());
    const props = show();
    expect(await screen.findByText("Confirm on 10 cases no round has run")).toBeInTheDocument();
    expect(screen.getByText("Runs once. About 180 credits.")).toBeInTheDocument();
    expect(confirmClimb).toHaveBeenCalledWith({ projectId: "proj_1", climbId: "climb_1", dryRun: true });
    await userEvent.click(screen.getByRole("button", { name: "Confirm" }));
    expect(confirmClimb).toHaveBeenCalledTimes(1);
    await userEvent.click(screen.getByRole("button", { name: "Run it" }));
    await waitFor(() => expect(confirmClimb).toHaveBeenLastCalledWith({ projectId: "proj_1", climbId: "climb_1" }));
    await waitFor(() => expect(props.onChanged).toHaveBeenCalled());
  });

  it("shows the confirmation's interval and says where the gain is within noise", async () => {
    const interval = (id: string, over: object) => ({ environmentId: id, measure: "pass_rate", unit: "points", cases: 10, difference: 27, low: 6, high: 45, includesZero: false, better: "higher", passRate: { baselineBps: 6700, bestBps: 9300 }, ...over });
    stopClimb.mockResolvedValue(
      stoppedResult(makeSummary({ confirmation: { status: "settled", usedByEarlierClimbs: [], notDecided: [], environments: [interval("env_a", {}), interval("env_b", { difference: 7, low: -15, high: 27, includesZero: true })] as never } })),
    );
    show();
    expect(await screen.findByText("Confirmed on 4 cases no round has run")).toBeInTheDocument();
    expect(screen.getByText("Between +6 and +45 points")).toBeInTheDocument();
    expect(screen.getByText("The gain holds on MCPJam · Sonnet.")).toBeInTheDocument();
    expect(screen.getByText(/On Claude Code · Sonnet it is within noise, so do not ship on it/)).toBeInTheDocument();
  });

  it("shows progress while the confirmation runs", async () => {
    stopClimb.mockResolvedValue(stoppedResult(makeSummary({ confirmation: { status: "running", usedByEarlierClimbs: [] } })));
    show({}, { confirmation: { status: "running", unitKey: "confirmation:1", startedAt: 1, startedBy: "u", estimatedCredits: 1 } });
    expect(await screen.findByText("progress confirmation:1")).toBeInTheDocument();
  });

  it("says why the summary did not load and offers to try again", async () => {
    stopClimb.mockRejectedValue(new Error("The climb is busy with a confirmation. Wait for it, then reload."));
    show();
    expect(await screen.findByText("The summary did not load")).toBeInTheDocument();
    expect(screen.getByText(/busy with a confirmation/)).toBeInTheDocument();
  });

  it("verifies with a commit and shows the gain on the mock beside the gain on the server", async () => {
    stopClimb.mockResolvedValue(stoppedResult(makeSummary({ confirmation: { status: "no_cases", usedByEarlierClimbs: [] } })));
    verifyClimb.mockResolvedValue({ ran: true, listingCheck: { changes: [] } });
    const props = show();
    await screen.findByText("Verify on your server");
    await userEvent.type(screen.getByLabelText("Commit"), "4f2c9ab");
    await userEvent.click(screen.getByRole("button", { name: "Verify" }));
    await waitFor(() => expect(verifyClimb).toHaveBeenCalledWith({ projectId: "proj_1", climbId: "climb_1", commit: { sha: "4f2c9ab" } }));
    expect(props.onChanged).toHaveBeenCalled();
  });

  it("shows a verification's result: each kept change in the listing, both gains, and whether it holds", async () => {
    stopClimb.mockResolvedValue(stoppedResult(makeSummary({ confirmation: { status: "no_cases", usedByEarlierClimbs: [] } })));
    show({}, {
      verifications: [{ index: 1, unitKey: "verification:1", status: "settled", listingCheck: { changes: [{ path: "tools.a.description", summary: "Rewrote the description", status: "applied" }] } }],
      verificationReports: [{ index: 1, holds: true, summary: "The gain holds on the real server.", commit: { sha: "4f2c9ab" }, environments: [{ environmentId: "env_a", baselineNowBps: 7000, gainOnMockBps: 1700, gainOnServerBps: 1100 }, { environmentId: "env_b", baselineNowBps: 10000 }] }],
    });
    expect(await screen.findByText("The gain holds on your server.")).toBeInTheDocument();
    expect(screen.getByText("Rewrote the description")).toBeInTheDocument();
    expect(screen.getByText("Applied")).toBeInTheDocument();
    expect(screen.getByText("+11 points")).toBeInTheDocument();
    expect(screen.getByText("Already passes every case")).toBeInTheDocument();
    expect(screen.getByText(/Commit 4f2c9ab/)).toBeInTheDocument();
  });

  it("stops at a kept change that is missing and runs anyway only when asked", async () => {
    stopClimb.mockResolvedValue(stoppedResult(makeSummary({ confirmation: { status: "no_cases", usedByEarlierClimbs: [] } })));
    verifyClimb
      .mockResolvedValueOnce({ ran: false, blockedBecause: "1 kept change is not in your server's listing yet. Apply it, or run anyway.", listingCheck: { changes: [{ path: "p", summary: "Rewrote the description of list_projects", status: "missing" }] } })
      .mockResolvedValueOnce({ ran: true, listingCheck: { changes: [] } });
    show();
    await screen.findByText("Verify on your server");
    await userEvent.click(screen.getByRole("button", { name: "Verify" }));
    expect(await screen.findByText(/not in your server's listing yet/)).toBeInTheDocument();
    expect(screen.getByText("Missing: Rewrote the description of list_projects")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Run anyway" }));
    await waitFor(() => expect(verifyClimb).toHaveBeenLastCalledWith({ projectId: "proj_1", climbId: "climb_1", runAnyway: true }));
  });

  it("goes back to the climbs", async () => {
    stopClimb.mockResolvedValue(stoppedResult());
    const props = show();
    await userEvent.click(await screen.findByRole("button", { name: "Back to climbs" }));
    expect(props.onBack).toHaveBeenCalled();
  });
});
