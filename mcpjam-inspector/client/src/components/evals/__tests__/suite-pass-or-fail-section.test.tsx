/**
 * The "Scorers and judges" section, and the policy controls beside it.
 *
 * Two properties are worth a test rather than a reading:
 *
 *   - an EMPTY stage says the right kind of nothing. `connection`, `discovery`
 *     and `call` have no authorable grader on this page — the runner measures
 *     them on every trial — so "No grader" there would read as a gap somebody
 *     should close. And neither answer may borrow `notMeasured`, which is a
 *     RUN-state word for a stage nobody observed.
 *   - the threshold field is a PERCENT over a stored FRACTION. Typing 80 must
 *     draft 0.8; drafting 80 would multiply every bar by a hundred, and the
 *     backend would refuse it after the save rather than at the keystroke.
 */

import { describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  SuiteBudgetsSection,
  SuitePassOrFailSection,
} from "../suite-pass-or-fail-section";
import {
  VerdictPolicyUpgradeButton,
  VerdictPolicyV2Controls,
} from "../suite-policy-controls";
import type { Predicate } from "@mcpjam/sdk/predicates";

vi.mock("posthog-js/react", () => ({
  useFeatureFlagEnabled: () => true,
}));

function renderSection(
  overrides: {
    predicates?: Predicate[];
    judgeConfig?: Parameters<typeof SuitePassOrFailSection>[0]["judgeConfig"];
    judgeAccessory?: React.ReactNode;
    rubricEditor?: React.ReactNode;
    stageFacts?: Parameters<typeof SuitePassOrFailSection>[0]["stageFacts"];
  } = {},
) {
  const onPredicatesChange = vi.fn();
  const onJudgeConfigChange = vi.fn();
  const onMatchOptionsChange = vi.fn();
  const result = render(
    <SuitePassOrFailSection
      matchOptions={undefined}
      onMatchOptionsChange={onMatchOptionsChange}
      predicates={overrides.predicates ?? []}
      onPredicatesChange={onPredicatesChange}
      judgeConfig={overrides.judgeConfig}
      onJudgeConfigChange={onJudgeConfigChange}
      availableModels={[]}
      judgeAccessory={overrides.judgeAccessory}
      rubricEditor={overrides.rubricEditor}
      stageFacts={overrides.stageFacts}
    />,
  );
  return { ...result, onPredicatesChange, onJudgeConfigChange };
}

function emptyCopy(container: HTMLElement, stage: string): string | null {
  return (
    container
      .querySelector(`[data-stage-empty="${stage}"]`)
      ?.textContent?.trim() ?? null
  );
}

describe("SuitePassOrFailSection", () => {
  it("mounts config facts under the stages the runner measures", () => {
    const { container } = renderSection({
      stageFacts: {
        connection: <div data-testid="connection-facts">connection facts</div>,
        discovery: <div data-testid="discovery-facts">discovery facts</div>,
      },
    });
    for (const stage of ["connection", "discovery"] as const) {
      const group = container.querySelector(`[data-stage-group="${stage}"]`);
      expect(
        group?.querySelector(`[data-testid="${stage}-facts"]`),
        stage,
      ).toBeTruthy();
    }
  });

  it("says 'No grader' for an unconfigured response stage", () => {
    const { container } = renderSection();
    expect(emptyCopy(container, "response")).toBe("No grader");
  });

  it("never tells a reader connection or discovery is ungraded", () => {
    const { container } = renderSection();
    for (const stage of ["connection", "discovery"]) {
      const copy = emptyCopy(container, stage) ?? "";
      expect(copy, stage).toContain("Observed by the runner");
      expect(copy.toLowerCase(), stage).not.toContain("no grader");
      // The run-state word. Settings has observed nothing, so claiming a
      // measurement did not happen states something nobody looked at.
      expect(copy.toLowerCase(), stage).not.toContain("not measured");
    }
  });

  it("marks the judge advisory by default and gating when the role says so", () => {
    const advisory = renderSection();
    expect(
      advisory.container.querySelector(
        '[data-testid="stage-chain-card-userValue"]',
      )?.textContent,
    ).toContain("Judge on request");
    advisory.unmount();

    const gating = renderSection({
      judgeConfig: { goalCompletion: { role: "gating" } },
    });
    const card = gating.container.querySelector(
      '[data-testid="stage-chain-card-userValue"]',
    );
    expect(card?.textContent).toContain("Gated");
    const group = gating.container.querySelector(
      '[data-stage-group="userValue"]',
    ) as HTMLElement;
    const judgeRole = group.querySelector('[aria-label="Judge role"]');
    expect(
      within(judgeRole as HTMLElement).getByRole("button", { name: "Gate" }),
    ).toHaveAttribute("aria-pressed", "true");
  });

  it("mounts the judge's gate panel and rubric editor under user value", () => {
    // The LAST link of the chain is the one a judge measures, so its readiness
    // and its criteria belong beside it rather than in a row of their own.
    const { container } = renderSection({
      judgeAccessory: <div data-testid="gate-panel" />,
      rubricEditor: <div data-testid="rubric-editor" />,
    });
    const group = container.querySelector(
      '[data-stage-group="userValue"]',
    ) as HTMLElement;
    expect(within(group).getByTestId("gate-panel")).toBeTruthy();
    expect(within(group).getByTestId("rubric-editor")).toBeTruthy();
    // Stamped so the settings manifest can claim it, and labelled so a reader
    // can match the row to the manifest entry.
    const rubricRow = container.querySelector(
      '[data-setting-key="judgeRubric"]',
    );
    expect(rubricRow?.textContent).toContain("Judge criteria");
  });

  it("keeps one Add-scorer affordance for the whole section", () => {
    // Per-stage Add menus would ask a person to know which stage their check
    // files under before they can write it, which is the page's job.
    const { container } = renderSection();
    expect(
      container.querySelectorAll('[data-setting-key="checks"]'),
    ).toHaveLength(1);
  });
});

describe("VerdictPolicyV2Controls", () => {
  it("renders a stored fraction as a percent and drafts a fraction back", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <VerdictPolicyV2Controls
        defaults={{ repetitions: 3, passThreshold: 0.5 }}
        onChange={onChange}
      />,
    );
    const input = screen.getByLabelText(
      /fraction of a case's trials that must pass/i,
    ) as HTMLInputElement;
    expect(input.value).toBe("50");

    await user.clear(input);
    await user.type(input, "80");
    await user.tab();
    expect(onChange).toHaveBeenCalledWith({
      repetitions: 3,
      // 0.8, NOT 80. A percent on the wire would move the bar by a factor of a
      // hundred and be refused after the save rather than at the keystroke.
      passThreshold: 0.8,
    });
  });

  it("shows how many passes the case decision rule needs", () => {
    render(
      <VerdictPolicyV2Controls
        defaults={{ repetitions: 3, passThreshold: 0.8 }}
        onChange={vi.fn()}
      />,
    );
    expect(
      screen.getByText(/A case with 3 trials needs 3 passes/),
    ).toBeTruthy();
  });

  it("clamps a typed percent into the unit interval", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <VerdictPolicyV2Controls
        defaults={{ repetitions: 1, passThreshold: 1 }}
        onChange={onChange}
      />,
    );
    const input = screen.getByLabelText(
      /fraction of a case's trials that must pass/i,
    );
    await user.clear(input);
    await user.type(input, "140");
    await user.tab();
    expect(onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ passThreshold: 1 }),
    );
  });
});

describe("VerdictPolicyUpgradeButton", () => {
  it("is disabled, with the reason, until the deployment says otherwise", () => {
    render(
      <VerdictPolicyUpgradeButton
        disabledReason="Not available on this deployment"
        proposal={{ repetitions: 1, passThreshold: 1 }}
        onUpgrade={vi.fn()}
      />,
    );
    const button = screen.getByRole("button", {
      name: /switch to verdict policy v2/i,
    });
    // The backend refuses the upgrade on a deployment whose ceiling is off, so
    // an enabled button here would have exactly one outcome: an error.
    expect(button).toBeDisabled();
    expect(screen.getByText("Not available on this deployment")).toBeTruthy();
  });

  it("proposes the legacy bar restated in v2 terms", async () => {
    const user = userEvent.setup();
    const onUpgrade = vi.fn();
    render(
      <VerdictPolicyUpgradeButton
        proposal={{ repetitions: 3, passThreshold: 0.8 }}
        onUpgrade={onUpgrade}
      />,
    );
    expect(screen.getByText(/3 repetitions, 80% threshold/)).toBeTruthy();
    await user.click(
      screen.getByRole("button", { name: /switch to verdict policy v2/i }),
    );
    expect(onUpgrade).toHaveBeenCalledWith({
      repetitions: 3,
      passThreshold: 0.8,
    });
  });
});

/**
 * The Limits tab.
 *
 * It used to render a read-only list that told the reader to add a ceiling
 * "from Checks" — a tab that names a setting and refuses to set it, and whose
 * own instruction was half false, since the Checks menu has never offered a
 * turn budget. These tests hold the two properties that fix depends on: both
 * ceiling kinds are addable HERE, and an edit re-seats itself in the one
 * `defaultPredicates` array without disturbing the checks around it.
 */
describe("SuiteBudgetsSection", () => {
  function renderBudgets(predicates: Predicate[]) {
    const onPredicatesChange = vi.fn();
    const result = render(
      <SuiteBudgetsSection
        predicates={predicates}
        onPredicatesChange={onPredicatesChange}
      />,
    );
    // The caller passes an updater; resolve it against the same list the row
    // was rendered from, which is what the draft reducer does.
    const nextPredicates = () => {
      const arg = onPredicatesChange.mock.calls.at(-1)?.[0];
      return typeof arg === "function" ? arg(predicates) : arg;
    };
    return { ...result, onPredicatesChange, nextPredicates };
  }

  it("offers both ceilings, and only ceilings, to add", async () => {
    const user = userEvent.setup();
    renderBudgets([]);
    await user.click(screen.getByRole("combobox"));
    const options = screen
      .getAllByRole("option")
      .map((option) => option.textContent?.trim());
    expect(options).toEqual([
      "Token budget under N",
      "Fewer than N user turns",
    ]);
  });

  it("adds a ceiling without disturbing the checks beside it", async () => {
    const user = userEvent.setup();
    const existing: Predicate[] = [
      { type: "toolCalledAtLeastOnce", toolName: "search" },
    ];
    const { nextPredicates } = renderBudgets(existing);
    await user.click(screen.getByRole("combobox"));
    await user.click(screen.getByRole("option", { name: /Token budget/ }));
    expect(nextPredicates()).toEqual([
      { type: "toolCalledAtLeastOnce", toolName: "search" },
      { type: "tokenBudgetUnder", tokens: 1000 },
    ]);
  });

  it("removes a ceiling from its own slot, leaving the rest in place", async () => {
    const user = userEvent.setup();
    const existing: Predicate[] = [
      { type: "tokenBudgetUnder", tokens: 1000 },
      { type: "toolCalledAtLeastOnce", toolName: "search" },
      { type: "turnCountUnder", turns: 10 },
    ];
    const { nextPredicates } = renderBudgets(existing);
    const [removeFirst] = screen.getAllByRole("button", { name: /remove/i });
    await user.click(removeFirst);
    expect(nextPredicates()).toEqual([
      { type: "turnCountUnder", turns: 10 },
      { type: "toolCalledAtLeastOnce", toolName: "search" },
    ]);
  });
});
