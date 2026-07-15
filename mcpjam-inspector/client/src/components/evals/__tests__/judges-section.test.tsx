import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { JudgesSection } from "../judges-section";
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
