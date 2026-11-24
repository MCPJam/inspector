import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const getClimbRound = vi.fn();
const decideRound = vi.fn();
vi.mock("@/lib/apis/climbs-api", () => ({
  getClimbRound: (...args: unknown[]) => getClimbRound(...args),
  decideRound: (...args: unknown[]) => decideRound(...args),
}));
vi.mock("../round-panes", () => ({ RoundPanes: () => <div data-testid="round-panes" /> }));
vi.mock("../running-view", () => ({
  RunningView: ({ title, eyebrow }: { title: string; eyebrow?: string }) => (
    <div data-testid="running-view">{eyebrow} {title}</div>
  ),
}));
vi.mock("../picker-transcript", () => ({
  PickerTranscript: ({ open }: { open: boolean }) => (open ? <div>MCPJam transcript sheet</div> : null),
}));

import { RoundView } from "../round-view";
import { makeClimb, makeRound, makeRoundDetail } from "./fixtures";

const labels = { env_a: "MCPJam · Sonnet", env_b: "Claude Code · Sonnet" };
const change = (summary: string) => ({ target: "tool" as const, kind: "changed" as const, summary, details: [{ path: "description", kind: "changed" as const, before: "List projects.", after: "Lists the projects you can open.", summary: "Changed the description" }] });

function show(round = makeRound(), detail = makeRoundDetail(), onChanged = vi.fn()) {
  getClimbRound.mockResolvedValue(detail);
  const climb = makeClimb({ state: "running", rounds: [round] });
  render(
    <RoundView
      climb={climb}
      roundNumber={1}
      changes={{ 1: [change('Changed the description of "list_projects"')] }}
      labels={labels}
      onChanged={onChanged}
    />,
  );
  return onChanged;
}

beforeEach(() => {
  getClimbRound.mockReset();
  decideRound.mockReset();
});

describe("RoundView", () => {
  it("shows a kept round: who, the change, the verdict, each environment and the panes", async () => {
    show();
    expect(await screen.findByText("Kept.")).toBeInTheDocument();
    expect(screen.getByText("Round 1 · You")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: 'Changed the description of "list_projects"' })).toBeInTheDocument();
    expect(screen.getByText(/MCPJam · Sonnet went from 78% to 94%/)).toBeInTheDocument();
    expect(screen.getAllByTestId("environment-cell")).toHaveLength(2);
    expect(screen.getByTestId("round-panes")).toBeInTheDocument();
    expect(screen.getByText("Validation cases didn't move")).toBeInTheDocument();
  });

  it("opens the change and the result table", async () => {
    show();
    await screen.findByText("Kept.");
    await userEvent.click(screen.getByRole("button", { name: "The change" }));
    expect(screen.getByText("Lists the projects you can open.")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Result by environment" }));
    expect(screen.getByText(/Measures pass rate/)).toBeInTheDocument();
  });

  it("links MCPJam's transcript only on a round MCPJam picked", async () => {
    show(makeRound({ pickedBy: "mcpjam", pickerChatSessionId: "chat_1" }));
    await userEvent.click(await screen.findByRole("button", { name: "MCPJam's transcript" }));
    expect(screen.getByText("MCPJam transcript sheet")).toBeInTheDocument();
  });

  it("has no transcript link on a round a person submitted", async () => {
    show();
    await screen.findByText("Kept.");
    expect(screen.queryByRole("button", { name: "MCPJam's transcript" })).not.toBeInTheDocument();
  });

  it("overrules with a reason, then reloads", async () => {
    decideRound.mockResolvedValue({});
    const onChanged = show();
    await screen.findByText("Kept.");
    await userEvent.click(screen.getByRole("button", { name: "Revert it" }));
    const confirm = screen.getByRole("button", { name: "Revert it", hidden: false });
    expect(screen.getAllByRole("button", { name: "Revert it" }).length).toBeGreaterThan(0);
    expect(confirm).toBeDisabled();
    await userEvent.type(screen.getByLabelText("Reason"), "It breaks a case I care about.");
    await userEvent.click(screen.getAllByRole("button", { name: "Revert it" }).at(-1)!);
    await waitFor(() =>
      expect(decideRound).toHaveBeenCalledWith({
        projectId: "proj_1",
        climbId: "climb_1",
        roundNumber: 1,
        decision: "reverted",
        reason: "It breaks a case I care about.",
      }),
    );
    expect(onChanged).toHaveBeenCalled();
  });

  it("explains a round that is not decided and offers Keep and Revert", async () => {
    show(
      makeRound({ verdict: "not_decided", standing: "not_decided" }),
      makeRoundDetail({ verdict: "not_decided", standing: "not_decided", reasons: ["real_server_changed"] }),
    );
    expect(await screen.findAllByText("Not decided")).toHaveLength(2);
    expect(screen.getByText(/mcpjam-mcp changed since the best so far was measured/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Keep it" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Revert it" })).toBeInTheDocument();
  });

  it("shows progress, not a result, while the round runs", () => {
    render(
      <RoundView
        climb={makeClimb({ rounds: [makeRound({ status: "running", verdict: undefined, standing: undefined, pickedBy: "mcpjam" })] })}
        roundNumber={1}
        changes={{}}
        labels={labels}
        onChanged={vi.fn()}
      />,
    );
    expect(screen.getByTestId("running-view")).toHaveTextContent("Round 1 · MCPJam");
  });

  it("says the change could not be read, and that a read failed, in words", async () => {
    getClimbRound.mockRejectedValue(new Error("The climb request was refused."));
    render(<RoundView climb={makeClimb({ rounds: [makeRound()] })} roundNumber={1} changes={{ 1: null }} labels={labels} onChanged={vi.fn()} />);
    expect(await screen.findByText("The round did not load")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument();
  });

  it("shows a loading line first", () => {
    getClimbRound.mockReturnValue(new Promise(() => undefined));
    render(<RoundView climb={makeClimb({ rounds: [makeRound()] })} roundNumber={1} changes={{}} labels={labels} onChanged={vi.fn()} />);
    expect(screen.getByRole("status")).toHaveTextContent("Loading the round.");
  });
});
