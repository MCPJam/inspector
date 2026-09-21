/**
 * The per-scenario rollout switch for per-turn ratings.
 *
 * The behaviour worth pinning is the in-flight guard: the control is
 * optimistic, so two clicks racing one `pending` slot can leave the switch
 * showing one thing and the server storing another.
 */
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ScenarioSettings } from "@/hooks/useScenarios";

const { updateScenarioMock, toastErrorMock } = vi.hoisted(() => ({
  updateScenarioMock: vi.fn(),
  toastErrorMock: vi.fn(),
}));

vi.mock("@/hooks/useScenarios", () => ({
  useScenarioMutations: () => ({ updateScenario: updateScenarioMock }),
}));

vi.mock("@/lib/toast", () => ({ toast: { error: toastErrorMock } }));

import { ScenarioPerTurnFeedbackToggle } from "../ScenarioPerTurnFeedbackToggle";

function scenario(enabled?: boolean): ScenarioSettings {
  return {
    scenarioId: "cbx_1",
    projectId: "proj_1",
    name: "Scenario",
    ...(enabled === undefined
      ? {}
      : { chatUi: { surfaces: { perTurnFeedback: { enabled } } } }),
  } as unknown as ScenarioSettings;
}

const toggle = () =>
  screen.getByTestId("user-testing-per-turn-feedback-toggle");

describe("ScenarioPerTurnFeedbackToggle", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    updateScenarioMock.mockResolvedValue(undefined);
  });

  it("reads off when the scenario has never opted in", () => {
    // The backend default is `false` and normalization defaults the whole
    // envelope, so an absent surface must read as off, not as unset-but-on.
    render(<ScenarioPerTurnFeedbackToggle scenario={scenario()} />);
    expect(toggle()).toHaveAttribute("data-state", "unchecked");
  });

  it("reads off when the chat UI envelope is explicitly null", () => {
    render(
      <ScenarioPerTurnFeedbackToggle
        scenario={{ ...scenario(), chatUi: null } as ScenarioSettings}
      />
    );
    expect(toggle()).toHaveAttribute("data-state", "unchecked");
  });

  it("writes only the perTurnFeedback surface", () => {
    render(<ScenarioPerTurnFeedbackToggle scenario={scenario(false)} />);
    fireEvent.click(toggle());
    expect(updateScenarioMock).toHaveBeenCalledWith({
      scenarioId: "cbx_1",
      chatUi: { surfaces: { perTurnFeedback: { enabled: true } } },
    });
  });

  it("serializes two dispatches that land in the same tick", async () => {
    // The in-flight latch is a REF, not state: two `onCheckedChange` calls in
    // one tick both read the pre-commit `saving`, so a state check would let
    // both through and out-of-order responses could persist the opposite of
    // the last click. Fired without an intervening act() flush precisely so
    // the `disabled` attribute is not what's under test — a user click on a
    // disabled switch never reaches the handler, which would make this pass
    // even with the latch removed.
    let resolveWrite: (() => void) | undefined;
    updateScenarioMock.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolveWrite = resolve;
        })
    );

    render(<ScenarioPerTurnFeedbackToggle scenario={scenario(false)} />);
    const control = toggle();
    act(() => {
      control.click();
      control.click();
    });

    expect(updateScenarioMock).toHaveBeenCalledTimes(1);
    resolveWrite?.();
    await waitFor(() => expect(toggle()).not.toBeDisabled());
  });

  it("holds the optimistic value until the server's catches up", async () => {
    // `scenario` arrives through a reactive query. Clearing the override when
    // the mutation resolves snaps the switch back to the old setting for the
    // frame or two before the update lands.
    updateScenarioMock.mockResolvedValue(undefined);
    const { rerender } = render(
      <ScenarioPerTurnFeedbackToggle scenario={scenario(false)} />
    );

    fireEvent.click(toggle());
    await waitFor(() => expect(toggle()).not.toBeDisabled());

    // Mutation resolved, reactive value has NOT arrived yet.
    expect(toggle()).toHaveAttribute("data-state", "checked");

    rerender(<ScenarioPerTurnFeedbackToggle scenario={scenario(true)} />);
    expect(toggle()).toHaveAttribute("data-state", "checked");
  });

  it("keeps a scenario's pending write out of the next scenario's state", () => {
    // The parent mounts this KEYED on scenarioId, so a scenario switch is a
    // remount, not reused state. Rendered with the same key React would use,
    // so a late-resolving write from the first scenario lands on a dead
    // instance instead of the live one.
    let resolveWrite: (() => void) | undefined;
    updateScenarioMock.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolveWrite = resolve;
        })
    );

    const { rerender } = render(
      <ScenarioPerTurnFeedbackToggle key="cbx_1" scenario={scenario(false)} />
    );
    fireEvent.click(toggle());
    expect(updateScenarioMock).toHaveBeenCalledTimes(1);
    expect(toggle()).toHaveAttribute("data-state", "checked");
    expect(toggle()).toBeDisabled();

    rerender(
      <ScenarioPerTurnFeedbackToggle
        key="cbx_2"
        scenario={{ ...scenario(false), scenarioId: "cbx_2" } as ScenarioSettings}
      />
    );

    // Fresh instance: no optimistic value, not disabled by the other write.
    expect(toggle()).toHaveAttribute("data-state", "unchecked");
    expect(toggle()).not.toBeDisabled();

    if (!resolveWrite) throw new Error("expected a pending write to resolve");
    resolveWrite();
  });

  it("reverts the switch when the write fails", async () => {
    updateScenarioMock.mockRejectedValue(new Error("nope"));
    render(<ScenarioPerTurnFeedbackToggle scenario={scenario(false)} />);

    fireEvent.click(toggle());

    await waitFor(() =>
      expect(toggle()).toHaveAttribute("data-state", "unchecked")
    );
    expect(toastErrorMock).toHaveBeenCalled();
  });
});

describe("ScenarioPerTurnFeedbackToggle — widget style", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    updateScenarioMock.mockResolvedValue(undefined);
  });

  const styled = (perTurnFeedback: Record<string, unknown>): ScenarioSettings =>
    ({
      scenarioId: "cbx_1",
      projectId: "proj_1",
      name: "Scenario",
      chatUi: { surfaces: { perTurnFeedback } },
    } as unknown as ScenarioSettings);

  const stylePicker = () =>
    screen.queryByTestId("user-testing-per-turn-feedback-style");
  const styleButton = (style: "stars" | "thumbs") =>
    screen.getByTestId(`user-testing-per-turn-feedback-style-${style}`);

  it("is hidden while the surface is off", () => {
    // A widget style is a question about a widget nobody is being shown.
    render(
      <ScenarioPerTurnFeedbackToggle scenario={styled({ enabled: false })} />
    );
    expect(stylePicker()).toBeNull();
  });

  it("defaults to stars for a scenario that predates the style field", () => {
    render(
      <ScenarioPerTurnFeedbackToggle scenario={styled({ enabled: true })} />
    );
    expect(styleButton("stars")).toHaveAttribute("aria-checked", "true");
    expect(styleButton("thumbs")).toHaveAttribute("aria-checked", "false");
  });

  it("reflects a stored thumbs style", () => {
    render(
      <ScenarioPerTurnFeedbackToggle
        scenario={styled({ enabled: true, style: "thumbs" })}
      />
    );
    expect(styleButton("thumbs")).toHaveAttribute("aria-checked", "true");
  });

  it("writes ONLY the style — the backend merge preserves enabled", () => {
    // Restating `enabled` here would be the style control asserting a rollout
    // decision it is not making, and would race a toggle write.
    render(
      <ScenarioPerTurnFeedbackToggle scenario={styled({ enabled: true })} />
    );

    fireEvent.click(styleButton("thumbs"));

    expect(updateScenarioMock).toHaveBeenCalledWith({
      scenarioId: "cbx_1",
      chatUi: { surfaces: { perTurnFeedback: { style: "thumbs" } } },
    });
  });

  it("does not write when the chosen style is already active", () => {
    render(
      <ScenarioPerTurnFeedbackToggle scenario={styled({ enabled: true })} />
    );
    fireEvent.click(styleButton("stars"));
    expect(updateScenarioMock).not.toHaveBeenCalled();
  });

  it("reverts to the stored style when the write fails", async () => {
    updateScenarioMock.mockRejectedValue(new Error("nope"));
    render(
      <ScenarioPerTurnFeedbackToggle scenario={styled({ enabled: true })} />
    );

    fireEvent.click(styleButton("thumbs"));

    await waitFor(() =>
      expect(styleButton("stars")).toHaveAttribute("aria-checked", "true")
    );
    expect(toastErrorMock).toHaveBeenCalled();
  });

  it("holds the style override until the SERVER's style catches up", async () => {
    // The two optimistic values live in one object with a PER-FIELD standdown.
    // `scenario` arrives through a reactive query that re-renders for reasons
    // that have nothing to do with this control; a shared "clear on any
    // resolve" rule would snap the segmented control back to the old style for
    // the frames before the write lands.
    let resolveWrite: (() => void) | undefined;
    updateScenarioMock.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolveWrite = resolve;
        })
    );

    const { rerender } = render(
      <ScenarioPerTurnFeedbackToggle scenario={styled({ enabled: true })} />
    );

    fireEvent.click(styleButton("thumbs"));
    expect(styleButton("thumbs")).toHaveAttribute("aria-checked", "true");

    // A reactive re-render arrives still carrying the OLD style.
    rerender(
      <ScenarioPerTurnFeedbackToggle
        scenario={styled({ enabled: true, prompt: "unrelated change" })}
      />
    );
    expect(styleButton("thumbs")).toHaveAttribute("aria-checked", "true");

    if (!resolveWrite) throw new Error("expected a pending write to resolve");
    await act(async () => {
      resolveWrite!();
    });

    // Only the server reporting the new style stands the override down.
    rerender(
      <ScenarioPerTurnFeedbackToggle
        scenario={styled({ enabled: true, style: "thumbs" })}
      />
    );
    expect(styleButton("thumbs")).toHaveAttribute("aria-checked", "true");
  });

  it("makes the description copy match the chosen style", () => {
    const { rerender } = render(
      <ScenarioPerTurnFeedbackToggle scenario={styled({ enabled: true })} />
    );
    expect(screen.getByText(/1–5 stars/)).toBeInTheDocument();

    rerender(
      <ScenarioPerTurnFeedbackToggle
        scenario={styled({ enabled: true, style: "thumbs" })}
      />
    );
    expect(screen.getByText(/👍 or 👎/)).toBeInTheDocument();
  });
});
