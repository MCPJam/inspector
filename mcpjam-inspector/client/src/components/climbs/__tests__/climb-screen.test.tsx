import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const getClimb = vi.fn();
const continueClimb = vi.fn();
const stopClimb = vi.fn();
vi.mock("@/lib/apis/climbs-api", () => ({
  getClimb: (...a: unknown[]) => getClimb(...a),
  continueClimb: (...a: unknown[]) => continueClimb(...a),
  stopClimb: (...a: unknown[]) => stopClimb(...a),
  mockChangesBetween: async () => [],
}));
vi.mock("../ready-view", () => ({ ReadyView: () => <div>ready view</div> }));
vi.mock("../new-round", () => ({
  NewRound: ({ onSubmitted }: { onSubmitted: (n: number) => void }) => (
    <button onClick={() => onSubmitted(2)}>new round view</button>
  ),
}));
vi.mock("../round-view", () => ({ RoundView: ({ roundNumber }: { roundNumber: number }) => <div>round view {roundNumber}</div> }));
vi.mock("../running-view", () => ({ RunningView: ({ title }: { title: string }) => <div>running {title}</div> }));
vi.mock("../stopped-summary", () => ({ StoppedSummary: () => <div>stopped summary</div> }));
vi.mock("../mock-sheet", () => ({ MockSheet: ({ open }: { open: boolean }) => (open ? <div>mock sheet</div> : null) }));

import { ClimbScreen } from "../climb-screen";
import { makeClimb, makeRound } from "./fixtures";

const labels = { env_a: "A", env_b: "B" };
const show = () => {
  const onBack = vi.fn();
  render(<ClimbScreen projectId="proj_1" climbId="climb_1" suiteName="dogfood" labels={labels} onBack={onBack} />);
  return onBack;
};

beforeEach(() => [getClimb, continueClimb, stopClimb].forEach((fn) => fn.mockReset()));

describe("ClimbScreen", () => {
  it("shows loading, then the baseline running for a climb that is baselining", async () => {
    getClimb.mockResolvedValue(makeClimb({ state: "baselining", activeUnitKey: "baseline:1" }));
    show();
    expect(screen.getByRole("status")).toHaveTextContent("Loading the climb.");
    expect(await screen.findByText("running Baseline")).toBeInTheDocument();
  });

  it("says why the baseline failed and runs it again from the button", async () => {
    getClimb.mockResolvedValue(
      makeClimb({ state: "baselining", baselineFailure: { unitKey: "baseline:1", reason: "Staging lost 3 of 12 iterations." } }),
    );
    continueClimb.mockResolvedValue({ resumed: false, baselineStarted: true });
    show();
    expect(await screen.findByText("Staging lost 3 of 12 iterations.")).toBeInTheDocument();
    expect(screen.queryByText("running Baseline")).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Run the baseline again" }));
    expect(continueClimb).toHaveBeenCalledWith({ projectId: "proj_1", climbId: "climb_1" });
    await waitFor(() => expect(getClimb).toHaveBeenCalledTimes(2));
  });

  it("keeps the failure on screen and says so when the baseline cannot start again", async () => {
    getClimb.mockResolvedValue(
      makeClimb({ state: "baselining", baselineFailure: { unitKey: "baseline:1", reason: "Staging lost 3 of 12 iterations." } }),
    );
    continueClimb.mockRejectedValue(new Error("Your plan has no credits left. Add credits, then try again."));
    show();
    await userEvent.click(await screen.findByRole("button", { name: "Run the baseline again" }));
    expect(await screen.findByText(/no credits left/)).toBeInTheDocument();
    expect(screen.getByText("Staging lost 3 of 12 iterations.")).toBeInTheDocument();
  });

  it("shows the running baseline, not the failure, while a new attempt runs", async () => {
    getClimb.mockResolvedValue(
      makeClimb({ state: "baselining", activeUnitKey: "baseline:2", baselineFailure: { unitKey: "baseline:1", reason: "Staging lost 3 of 12 iterations." } }),
    );
    show();
    expect(await screen.findByText("running Baseline")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Run the baseline again" })).not.toBeInTheDocument();
  });

  it("lands on the ready view when no round has run", async () => {
    getClimb.mockResolvedValue(makeClimb({ state: "ready" }));
    show();
    expect(await screen.findByText("ready view")).toBeInTheDocument();
  });

  it("lands on the latest round, and moves to a round just submitted", async () => {
    getClimb.mockResolvedValue(makeClimb({ state: "running", rounds: [makeRound({ number: 1 }), makeRound({ number: 2, status: "running", verdict: undefined, standing: undefined })] }));
    show();
    expect(await screen.findByText("round view 2")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /New round/ }));
    await userEvent.click(screen.getByRole("button", { name: "new round view" }));
    expect(await screen.findByText("round view 2")).toBeInTheDocument();
  });

  it("opens the mock's sheet from the bar", async () => {
    getClimb.mockResolvedValue(makeClimb({ state: "ready" }));
    show();
    await userEvent.click(await screen.findByRole("button", { name: "Open the mock server" }));
    expect(screen.getByText("mock sheet")).toBeInTheDocument();
  });

  it("shows a paused climb's banner, and Continue resumes it and reads the climb again", async () => {
    getClimb.mockResolvedValue(makeClimb({ state: "ready", picker: "mcpjam", paused: { at: 1, code: "inspector_stopped", reason: "Your Inspector stopped. Continue runs the step again." } }));
    continueClimb.mockResolvedValue({ resumed: true, stepDue: true });
    show();
    await userEvent.click(await screen.findByRole("button", { name: "Continue" }));
    await waitFor(() => expect(continueClimb).toHaveBeenCalledWith({ projectId: "proj_1", climbId: "climb_1" }));
    await waitFor(() => expect(getClimb.mock.calls.length).toBeGreaterThan(1));
  });

  it("shows the summary of a stopped climb", async () => {
    getClimb.mockResolvedValue(makeClimb({ state: "stopped" }));
    show();
    expect(await screen.findByText("stopped summary")).toBeInTheDocument();
  });

  it("says why a climb did not load, and goes back", async () => {
    getClimb.mockRejectedValue(new Error("This climb does not exist, or it belongs to another project. Go back to the suite's Climb tab."));
    const onBack = show();
    expect(await screen.findByText("The climb did not load")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Back to climbs" }));
    expect(onBack).toHaveBeenCalled();
  });
});
