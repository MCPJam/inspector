import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { SuiteScorerTable } from "../suite-scorer-table";
import { PASS_OR_FAIL_HINT, JUDGE_HINT } from "../suite-pass-or-fail-section";
import { SuiteSettingsRow } from "../suite-settings-row";
import { SuiteSettingsCompactContext } from "../suite-settings-compact";

vi.mock("@/components/chat-v2/chat-input/model/provider-logo", () => ({
  ProviderLogo: () => <span aria-hidden="true" />,
}));
vi.mock("posthog-js/react", () => ({ useFeatureFlagEnabled: () => true }));

function compact(node: React.ReactNode) {
  return render(
    <SuiteSettingsCompactContext.Provider value>
      {node}
    </SuiteSettingsCompactContext.Provider>,
  );
}

function scorerTable() {
  return (
    <SuiteScorerTable
      matchOptions={undefined}
      onMatchOptionsChange={vi.fn()}
      scope={{
        kind: "suite",
        predicates: [
          { type: "noToolErrors" },
          { type: "toolLatencyUnder", ms: 1234 },
        ],
        onPredicatesChange: vi.fn(),
      }}
      judgeConfig={undefined}
      onJudgeConfigChange={vi.fn()}
      availableModels={[]}
      passOrFailHint={PASS_OR_FAIL_HINT}
      judgeHint={JUDGE_HINT}
    />
  );
}

describe("compact settings rows (V-5)", () => {
  it("puts the label beside the control with the hint behind an info pill", () => {
    const { container } = compact(
      <SuiteSettingsRow
        settingKey="iterations"
        chained={false}
        hint="How many times each case runs."
        data-subsection-id="iterations"
      >
        <span>control</span>
      </SuiteSettingsRow>,
    );
    const row = container.querySelector('[data-setting-key="iterations"]');
    expect(row?.className).toContain("sm:grid-cols-[13rem_minmax(0,1fr)]");
    expect(row?.getAttribute("data-subsection-id")).toBe("iterations");
    expect(
      screen.getByRole("heading", { name: "Iterations" }).className,
    ).toContain("text-sm font-medium");
    const pill = screen.getByRole("button", { name: "About Iterations" });
    expect(pill.getAttribute("tabindex")).toBe("0");
    expect(screen.queryByText("How many times each case runs.")).toBeNull();
    expect(screen.getByText("control")).toBeTruthy();
  });

  it("keeps the stacked layout without the context", () => {
    render(
      <SuiteSettingsRow settingKey="iterations" chained={false} hint="Hint">
        <span>control</span>
      </SuiteSettingsRow>,
    );
    expect(screen.getByText("Hint")).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: "About Iterations" }),
    ).toBeNull();
  });
});

describe("compact evaluators table (V-6, I-4)", () => {
  it("heads the section at 16px with a pill and moves Edit evaluators beside Add assertion", () => {
    compact(scorerTable());
    const heading = screen.getByRole("heading", { name: "Evaluators" });
    expect(heading.className).toContain("text-base");
    expect(
      screen.getByRole("button", { name: "About Evaluators" }),
    ).toBeTruthy();
    expect(screen.queryByText(PASS_OR_FAIL_HINT)).toBeNull();
    const edit = screen.getByRole("button", { name: "Edit evaluators" });
    const actions = edit.parentElement as HTMLElement;
    expect(
      within(actions).getByRole("button", { name: /Add assertion/ }),
    ).toBeTruthy();
  });

  it("ticking a box changes only that row", () => {
    const { container } = compact(scorerTable());
    const row = container.querySelector(
      '[data-scorer-id="predicate:0"]',
    ) as HTMLElement;
    fireEvent.click(
      within(row).getByRole("checkbox", { name: "Tool errors (isError)" }),
    );
    expect(
      screen.getByRole("button", { name: "Edit evaluators" }),
    ).toHaveAttribute("aria-expanded", "false");
    expect(container.querySelectorAll("[data-scorer-editor]")).toHaveLength(0);
  });

  it("tightens the stage rows", () => {
    const { container } = compact(scorerTable());
    const group = container.querySelector("[data-stage-group]") as HTMLElement;
    expect(group.className).toContain("py-3");
    expect(group.className).not.toContain("py-5");
  });
});
