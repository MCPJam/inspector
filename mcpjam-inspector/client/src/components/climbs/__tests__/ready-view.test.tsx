import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

// A plain function, not a spy, for the failing case: the runner counts a spy's rejected copy as unhandled.
const updateClimbMeasure = vi.fn();
let refusal: Error | undefined;
vi.mock("@/lib/apis/climbs-api", () => ({
  updateClimbMeasure: async (...args: unknown[]) => {
    updateClimbMeasure(...args);
    if (refusal) throw refusal;
    return {};
  },
}));
vi.mock("../failed-run-sheet", () => ({
  FailedRunSheet: ({ run }: { run: { caseTitle?: string } | null }) => (run ? <div>Sheet for {run.caseTitle}</div> : null),
}));

import { ReadyView } from "../ready-view";
import { baselineEnv, failedRun, makeClimb, makeOption } from "./fixtures";

const labels = { env_a: "MCPJam · Sonnet", env_b: "Claude Code · Sonnet" };

function climbWith(extra: object = {}) {
  return makeClimb({
    baseline: { settledAt: 1, environments: [baselineEnv("env_a", 7800, 7800), baselineEnv("env_b", 6100, 6700)] },
    climbFor: [
      makeOption({ failedRuns: [failedRun(1), failedRun(2)] }),
      makeOption({ id: "tokens", label: "Tokens", measure: "tokens", number: { value: 4210, unit: "tokens", text: "4,210 a model call" } }),
      makeOption({ id: "cost", label: "Cost", measure: "cost", available: false, reason: "Cost was not recorded." }),
    ],
    suiteCheck: { ready: true, measure: "pass_rate", canShowChange: true, environments: [], steeringToolsWithoutValidation: ["list_projects"], findings: [{ code: "flipped_cases", severity: "warns", message: "2 cases passed in one run and failed in the other." }] },
    ...extra,
  });
}

function show(climb = climbWith(), over: Partial<React.ComponentProps<typeof ReadyView>> = {}) {
  const props = { climb, labels, suiteName: "dogfood", selected: "tool_descriptions", onSelect: vi.fn(), onNext: vi.fn(), onChanged: vi.fn(), ...over };
  render(<ReadyView {...props} />);
  return props;
}

beforeEach(() => {
  updateClimbMeasure.mockReset();
  refusal = undefined;
});

describe("ReadyView", () => {
  it("shows the baseline of each environment with both runs and the noise", () => {
    show();
    const cards = screen.getAllByTestId("baseline-card");
    expect(cards).toHaveLength(2);
    expect(cards[1]).toHaveTextContent("Claude Code · Sonnet");
    expect(cards[1]).toHaveTextContent("61%, 67%");
    expect(cards[1]).toHaveTextContent("Noise ±5.6%");
  });

  it("lists Climb for as one list with each option's number, and the rule of the chosen one", () => {
    show();
    expect(screen.getByText("7 of 13 failed iterations picked the wrong tool")).toBeInTheDocument();
    expect(screen.getByText("4,210 a model call")).toBeInTheDocument();
    expect(screen.getByText(/Measures pass rate\. A change is kept when pass rate goes up/)).toBeInTheDocument();
    expect(screen.getByText("Cost was not recorded.")).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: /Cost/ })).toBeDisabled();
  });

  it("opens a failed run behind the chosen option", async () => {
    show();
    await userEvent.click(screen.getByRole("button", { name: /Counts projects 1/ }));
    expect(screen.getByText("Sheet for Counts projects 1")).toBeInTheDocument();
  });

  it("sets the measure when an option for another measure is chosen, then selects it", async () => {
    const props = show();
    await userEvent.click(screen.getByRole("radio", { name: /Tokens/ }));
    await waitFor(() => expect(props.onSelect).toHaveBeenCalledWith("tokens"));
    expect(updateClimbMeasure).toHaveBeenCalledWith({ projectId: "proj_1", climbId: "climb_1", measure: "tokens" });
    expect(props.onChanged).toHaveBeenCalled();
  });

  it("keeps the selection and says why when the measure was not saved", async () => {
    refusal = new Error("The measure is fixed once round 1 has settled.");
    const props = show();
    await userEvent.click(screen.getByRole("radio", { name: /Tokens/ }));
    expect(await screen.findByText(/fixed once round 1 has settled/)).toBeInTheDocument();
    expect(props.onSelect).not.toHaveBeenCalled();
  });

  it("goes on to choosing a change", async () => {
    const props = show();
    await userEvent.click(screen.getByRole("button", { name: /Choose a change/ }));
    expect(props.onNext).toHaveBeenCalled();
  });

  it("offers nothing to choose on a stopped climb", () => {
    show(climbWith({ state: "stopped" }));
    expect(screen.getByRole("button", { name: /Choose a change/ })).toBeDisabled();
  });

  it("opens the suite check and offers the cases prompt for tools no validation case covers", async () => {
    show();
    expect(screen.getByText("1 thing to know.")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /Suite check/ }));
    expect(screen.getByText("Unstable cases")).toBeInTheDocument();
    expect(screen.getByText("2 cases passed in one run and failed in the other.")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Add cases with your agent" }));
    expect(await screen.findByRole("dialog")).toHaveTextContent('suite "dogfood"');
  });

  it("labels the finding for an environment that replays one decision", async () => {
    show(
      climbWith({
        suiteCheck: { ready: true, measure: "pass_rate", canShowChange: true, environments: [], steeringToolsWithoutValidation: [], findings: [{ code: "replays_one_decision", severity: "warns", environmentId: "env_a", message: "The two baseline runs gave the same result in every case, to the token." }] },
      }),
    );
    await userEvent.click(screen.getByRole("button", { name: /Suite check/ }));
    expect(screen.getByText("One decision")).toBeInTheDocument();
    expect(screen.getByText(/same result in every case, to the token/)).toBeInTheDocument();
  });

  it("says the suite cannot show a change when the check says so", () => {
    show(climbWith({ suiteCheck: { ready: true, measure: "tokens", canShowChange: false, environments: [], steeringToolsWithoutValidation: [], findings: [] } }));
    expect(screen.getByText(/cannot show a change yet/)).toBeInTheDocument();
  });

  it("says the options are not there yet before the server has been read", () => {
    show(climbWith({ climbFor: undefined, suiteCheck: undefined }));
    expect(screen.getByText(/appear once the baseline has settled/)).toBeInTheDocument();
  });
});
