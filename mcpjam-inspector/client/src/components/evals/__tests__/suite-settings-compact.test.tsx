import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { SuiteScorerTable } from "../suite-scorer-table";
import { PASS_OR_FAIL_HINT, JUDGE_HINT } from "../suite-pass-or-fail-section";
import { SuiteSettingsRow } from "../suite-settings-row";
import { SuiteSettingsCompactContext } from "../suite-settings-compact";
import {
  SuiteBudgetSettingsRows,
  SuiteSettingsLockFrame,
} from "../suite-settings-row-parts";
import {
  initSuiteSettingsDraft,
  readSuiteSettingsValues,
} from "../suite-settings-draft";

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

/** Per-turn timeout authored; every other budget left to the platform. */
function budgetRows() {
  const draft = initSuiteSettingsDraft({
    suiteId: "s1",
    values: readSuiteSettingsValues({
      executionBudgets: { turnTimeoutMs: 360_000 },
    }),
  });
  return (
    <SuiteBudgetSettingsRows
      sheet={{
        draft,
        dispatchDraft: vi.fn(),
        rowIsDirty: () => false,
        rowIsConflict: () => false,
      }}
    />
  );
}

const rowOf = (container: HTMLElement, key: string) =>
  container.querySelector(`[data-setting-key="${key}"]`) as HTMLElement;

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

  it("drops the sheet's row gap so compact rows sit on their dividers", () => {
    const sheet = { configLocked: false, editingDisabled: false };
    const { container, unmount } = compact(
      <SuiteSettingsLockFrame sheet={sheet}>
        <span>rows</span>
      </SuiteSettingsLockFrame>,
    );
    expect(container.querySelector("fieldset")?.className).not.toContain(
      "space-y-8",
    );
    unmount();
    const stacked = render(
      <SuiteSettingsLockFrame sheet={sheet}>
        <span>rows</span>
      </SuiteSettingsLockFrame>,
    );
    expect(stacked.container.querySelector("fieldset")?.className).toContain(
      "space-y-8",
    );
  });

  it("marks an un-authored budget with a Platform default chip", () => {
    const { container } = compact(budgetRows());
    const toolCall = within(rowOf(container, "toolCallTimeoutMs"));
    const chip = toolCall.getByText("Platform default");
    expect(chip.getAttribute("title")).toBe(
      "Leave empty to keep the platform default",
    );
    expect(chip.className).toContain("rounded-full");
    expect(toolCall.queryByText("inheriting the platform default")).toBeNull();
    const turn = within(rowOf(container, "turnTimeoutMs"));
    expect(turn.queryByText("Platform default")).toBeNull();
    expect(turn.queryByText("inheriting the platform default")).toBeNull();
  });

  it("keeps the sheet's sentence for an un-authored budget outside the page", () => {
    const { container } = render(budgetRows());
    const toolCall = within(rowOf(container, "toolCallTimeoutMs"));
    expect(toolCall.getByText("inheriting the platform default")).toBeTruthy();
    expect(toolCall.queryByText("Platform default")).toBeNull();
    const turn = within(rowOf(container, "turnTimeoutMs"));
    expect(turn.queryByText("inheriting the platform default")).toBeNull();
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
