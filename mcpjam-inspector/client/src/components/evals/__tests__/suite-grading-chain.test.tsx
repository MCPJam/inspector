import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { USER_VALUE_STAGES } from "@mcpjam/sdk/contract";
import { SuiteGradingChain } from "../suite-grading-chain";
import type { StageConfigState } from "../suite-grading-model";

const DEFAULT_STATES: StageConfigState[] = [
  { stage: "connection", state: "runner", gates: 0 },
  { stage: "discovery", state: "runner", gates: 0 },
  { stage: "selection", state: "gated", gates: 2 },
  { stage: "call", state: "gated", gates: 1 },
  { stage: "response", state: "gap", gates: 0 },
  { stage: "userValue", state: "judgeOnRequest", gates: 0, judge: "manual" },
];

describe("SuiteGradingChain", () => {
  it("renders six links in USER_VALUE_STAGES order", () => {
    render(<SuiteGradingChain states={DEFAULT_STATES} />);
    const list = screen.getByRole("tablist", { name: "User value chain" });
    const items = within(list).getAllByRole("tab");
    expect(items.map((item) => item.getAttribute("data-stage-state"))).toEqual([
      "runner",
      "runner",
      "gated",
      "gated",
      "gap",
      "judgeOnRequest",
    ]);
    expect(items).toHaveLength(USER_VALUE_STAGES.length);
    expect(list.textContent).toContain("runner");
    expect(list.textContent).toContain("2 gates");
    expect(list.textContent).toContain("no grader");
    expect(list.textContent).toContain("judge on request");
  });

  it("labels the four judge modes", () => {
    const byMode = {
      off: "judge off",
      manual: "judge on request",
      automatic: "judge, advisory",
      gating: "judge gates",
    } as const;
    for (const [mode, label] of Object.entries(byMode)) {
      const states: StageConfigState[] = DEFAULT_STATES.map((state) =>
        state.stage === "userValue"
          ? {
              stage: "userValue",
              state:
                mode === "off"
                  ? "judgeOff"
                  : mode === "manual"
                    ? "judgeOnRequest"
                    : mode === "automatic"
                      ? "judgeAutomatic"
                      : "gated",
              gates: 0,
              judge: mode as StageConfigState["judge"],
            }
          : state,
      );
      const { unmount } = render(<SuiteGradingChain states={states} />);
      expect(screen.getByRole("tablist").textContent).toContain(label);
      unmount();
    }
  });

  it("combines a deterministic gate with a judge on request", () => {
    const states: StageConfigState[] = DEFAULT_STATES.map((state) =>
      state.stage === "userValue"
        ? {
            stage: "userValue",
            state: "gated",
            gates: 1,
            judge: "manual",
          }
        : state,
    );
    render(<SuiteGradingChain states={states} />);
    expect(screen.getByRole("tablist").textContent).toContain(
      "1 gate · judge on request",
    );
  });
});

describe("SuiteGradingChain as navigation", () => {
  it("selects a stage tab and reports the selection", () => {
    const onSelectStage = vi.fn();
    render(
      <SuiteGradingChain
        states={DEFAULT_STATES}
        activeStage="selection"
        onSelectStage={onSelectStage}
      />,
    );
    const list = screen.getByRole("tablist", { name: "User value chain" });
    const tabs = within(list).getAllByRole("tab");
    expect(tabs).toHaveLength(USER_VALUE_STAGES.length);
    expect(
      within(list)
        .getByRole("tab", { name: /Selection/ })
        .getAttribute("aria-selected"),
    ).toBe("true");
    expect(
      within(list)
        .getByRole("tab", { name: /Response/ })
        .getAttribute("aria-selected"),
    ).toBe("false");

    fireEvent.mouseDown(within(list).getByRole("tab", { name: /User value/ }));
    expect(onSelectStage).toHaveBeenCalledWith("userValue");
  });

  it("shows every state with no tab selected when there is no selector", () => {
    render(<SuiteGradingChain states={DEFAULT_STATES} />);
    const list = screen.getByRole("tablist", { name: "User value chain" });
    expect(
      within(list)
        .getAllByRole("tab")
        .every((tab) => tab.getAttribute("aria-selected") === "false"),
    ).toBe(true);
    expect(list.textContent).toContain("no grader");
  });
});
