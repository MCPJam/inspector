/**
 * The "Evaluators" section, and the policy controls beside it.
 *
 * Two properties are worth a test rather than a reading:
 *
 *   - an EMPTY stage says the right kind of nothing. `connection`, `discovery`
 *     and `call` have no authorable grader on this page — the runner measures
 *     them on every iteration — so "No evaluator" there would read as a gap somebody
 *     should close. And neither answer may borrow `notMeasured`, which is a
 *     RUN-state word for a stage nobody observed.
 *   - the threshold field is a PERCENT over a stored FRACTION. Typing 80 must
 *     draft 0.8; drafting 80 would multiply every bar by a hundred, and the
 *     backend would refuse it after the save rather than at the keystroke.
 */

import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SuitePassOrFailSection } from "../suite-pass-or-fail-section";
import {
  PerCaseIterationsControl,
  PerCasePassThresholdControl,
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

  it("says 'No evaluator' for an unconfigured response stage", () => {
    const { container } = renderSection();
    // The stage lists its standard assertions as off rows, none of them on.
    const rows = Array.from(
      container.querySelectorAll(
        '[data-stage-group="response"] [data-scorer-row]',
      ),
    );
    expect(rows.length).toBeGreaterThan(0);
    expect(
      rows.every(
        (row) =>
          row.getAttribute("data-scorer-row") === "preset" &&
          row.getAttribute("data-scorer-enabled") === "false",
      ),
    ).toBe(true);
  });

  it("never tells a reader connection or discovery is ungraded", () => {
    const { container } = renderSection();
    for (const stage of ["connection", "discovery"]) {
      const copy = emptyCopy(container, stage) ?? "";
      expect(copy, stage).toContain("Required");
      expect(copy.toLowerCase(), stage).not.toContain("no evaluator");
      // The run-state word. Settings has observed nothing, so claiming a
      // measurement did not happen states something nobody looked at.
      expect(copy.toLowerCase(), stage).not.toContain("not measured");
    }
  });

  it("marks the judge advisory by default and required when the role says so", () => {
    const advisory = renderSection();
    fireEvent.click(
      within(advisory.container).getByRole("button", {
        name: "Goal completion judge",
      }),
    );
    expect(
      within(
        advisory.container.querySelector(
          '[data-scorer-id="judge:goalCompletion"]',
        ) as HTMLElement,
      ).getByText("Advisory"),
    ).toBeTruthy();
    advisory.unmount();

    const gating = renderSection({
      judgeConfig: { goalCompletion: { role: "gating" } },
    });
    const group = gating.container.querySelector(
      '[data-stage-group="userValue"]',
    ) as HTMLElement;
    // The row's control reads Required; it sits on the row itself.
    fireEvent.click(
      within(group).getByRole("button", { name: "Goal completion judge" }),
    );
    const judgeRole = group.querySelector('[aria-label="Judge role"]');
    expect(
      within(judgeRole as HTMLElement).getByRole("button", {
        name: "Required",
      }),
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
    expect(rubricRow?.textContent).toContain("Grading instructions");
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

describe("PerCasePassThresholdControl", () => {
  it("renders a stored fraction as a percent and drafts a fraction back", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <PerCasePassThresholdControl
        defaults={{ repetitions: 3, passThreshold: 0.5 }}
        onChange={onChange}
      />,
    );
    const input = screen.getByLabelText(
      /fraction of a case's iterations that must pass/i,
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
      <PerCasePassThresholdControl
        defaults={{ repetitions: 3, passThreshold: 0.8 }}
        onChange={vi.fn()}
      />,
    );
    expect(
      screen.getByText(/A case with 3 iterations needs 3 passes/),
    ).toBeTruthy();
  });

  it("clamps a typed percent into the unit interval", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <PerCasePassThresholdControl
        defaults={{ repetitions: 1, passThreshold: 1 }}
        onChange={onChange}
      />,
    );
    const input = screen.getByLabelText(
      /fraction of a case's iterations that must pass/i,
    );
    await user.clear(input);
    await user.type(input, "140");
    await user.tab();
    expect(onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ passThreshold: 1 }),
    );
  });
});

describe("PerCaseIterationsControl", () => {
  it("drafts the count without touching the threshold", async () => {
    // The two are separate rows now, and each writes back the WHOLE stored
    // object — so a count edit that dropped the threshold would look like a
    // threshold reset nobody made.
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <PerCaseIterationsControl
        defaults={{ repetitions: 3, passThreshold: 0.8 }}
        onChange={onChange}
      />,
    );
    await user.selectOptions(
      screen.getByLabelText(
        /iterations per case unless the case overrides it/i,
      ),
      "5",
    );
    expect(onChange).toHaveBeenCalledWith({
      repetitions: 5,
      passThreshold: 0.8,
    });
  });

  it("names the count a DEFAULT, never a minimum", () => {
    // A case at 7 resolves to 7 under a floor of 3 and to 3 under a default of
    // 3. The word is the only thing telling a reader which rule they are
    // editing.
    render(
      <PerCaseIterationsControl
        defaults={{ repetitions: 3, passThreshold: 0.8 }}
        onChange={vi.fn()}
      />,
    );
    expect(screen.getByText("Iterations per case")).toBeTruthy();
    expect(screen.queryByText(/minimum iterations/i)).toBeNull();
  });
});

// ── Deliberately gone: the scope-switch button ───────────────────────────────
//
// `VerdictPolicyUpgradeButton` was tested here for its disabled reason and for
// proposing "the legacy bar restated in v2 terms". That restatement divided the
// stored percent by 100 — which preserves the NUMBER and moves the BAR for
// every suite with more than one case, because a suite-wide percent and a
// per-case fraction are measured over different populations. Changing the
// scope is API-only until an explicit operation ships in a follow-up, so there
// is no scope-change component here to test.
