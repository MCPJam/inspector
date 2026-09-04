import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { JudgesSection, pruneEmpty } from "../judges-section";
import type { EvalJudgeConfig } from "../types";

function renderBare(value: EvalJudgeConfig | undefined) {
  const onChange = vi.fn();
  render(
    <JudgesSection
      chrome="bare"
      value={value}
      availableModels={[]}
      onChange={onChange}
    />,
  );
  return { onChange };
}

describe("JudgesSection — bare (suite settings) auto-grade toggle", () => {
  it("turning it ON enables AND auto-runs (one switch = auto-grade every run)", async () => {
    const user = userEvent.setup();
    // A suite that was 'enabled' the old way (no autoRun) reads as OFF here,
    // because it is NOT actually auto-grading yet.
    const { onChange } = renderBare({ goalCompletion: { enabled: true } });
    const sw = screen.getByRole("switch", {
      name: /auto-grade every run/i,
    });
    expect(sw).toHaveAttribute("data-state", "unchecked");

    await user.click(sw);
    expect(onChange).toHaveBeenCalledWith({
      goalCompletion: expect.objectContaining({ enabled: true, autoRun: true }),
    });
  });

  it("shows ON only when it will actually auto-grade (enabled && autoRun)", () => {
    renderBare({ goalCompletion: { enabled: true, autoRun: true } });
    expect(
      screen.getByRole("switch", { name: /auto-grade every run/i }),
    ).toHaveAttribute("data-state", "checked");
  });

  it("turning it OFF disables the judge", async () => {
    const user = userEvent.setup();
    const { onChange } = renderBare({
      goalCompletion: { enabled: true, autoRun: true },
    });
    await user.click(
      screen.getByRole("switch", { name: /auto-grade every run/i }),
    );
    expect(onChange).toHaveBeenCalledWith({
      goalCompletion: expect.objectContaining({ enabled: false }),
    });
  });

  it("surfaces that it uses credits", () => {
    renderBare({ goalCompletion: { enabled: true, autoRun: true } });
    expect(screen.getByText(/uses credits/i)).toBeInTheDocument();
  });
});

describe("pruneEmpty keeps a config that still means something", () => {
  it("drops a config with nothing set", () => {
    expect(pruneEmpty({ goalCompletion: {} })).toBeUndefined();
    expect(pruneEmpty({})).toBeUndefined();
  });

  it("treats an empty model string as nothing", () => {
    expect(pruneEmpty({ goalCompletion: { judgeModel: "" } })).toBeUndefined();
  });

  it("KEEPS a config whose only field is the gating role", () => {
    // The case that matters. `enabled` may legitimately be absent — the
    // backend resolves an absent one to on — so a gating suite can carry
    // `role` and nothing else. Resetting the model to the managed default
    // clears `judgeModel`, and before `role` was counted here that made the
    // whole config prune away: a gate the organization had to earn, erased by
    // an unrelated edit, with no error and no toast.
    expect(pruneEmpty({ goalCompletion: { role: "gating" } })).toEqual({
      goalCompletion: { role: "gating" },
    });
    expect(pruneEmpty({ goalCompletion: { role: "advisory" } })).toEqual({
      goalCompletion: { role: "advisory" },
    });
  });

  it("keeps each of the other meaningful fields on its own", () => {
    for (const gc of [
      { enabled: false },
      { judgeModel: "openai/gpt-5.4-mini" },
      { threshold: 0.8 },
      { autoRun: true },
    ]) {
      expect(pruneEmpty({ goalCompletion: gc })).toEqual({
        goalCompletion: gc,
      });
    }
  });
});
