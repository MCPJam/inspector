/**
 * One table, two scopes. The suite page owns its rules; a case inherits
 * them read-only, suppresses them by family, and edits only its own.
 */

import { describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Predicate } from "@mcpjam/sdk/predicates";
import { SuiteScorerTable, BACKEND_SUPPORT_HINT } from "../suite-scorer-table";
import { PASS_OR_FAIL_HINT, JUDGE_HINT } from "../suite-pass-or-fail-section";
import {
  STANDARD_ASSERTION_CHECKS,
  type StandardCheckDraft,
} from "../standard-checks-model";
import type { SuiteCapabilities } from "@/hooks/use-suite-capabilities";

vi.mock("posthog-js/react", () => ({
  useFeatureFlagEnabled: () => true,
}));

const latency = STANDARD_ASSERTION_CHECKS.find(
  (check) => check.id === "response.performance",
)!;
const errors = STANDARD_ASSERTION_CHECKS.find(
  (check) => check.id === "response.errors",
)!;
const allKinds = {
  scorers: {
    predicateKinds: STANDARD_ASSERTION_CHECKS.map((c) => c.preset.type),
    suppressedSuiteStandardCheckIds: true,
    checkPolicy: true,
  },
} as SuiteCapabilities;

const row = (container: HTMLElement, id: string) =>
  container.querySelector(`[data-scorer-id="${id}"]`) as HTMLElement;

function renderSuite(predicates: Predicate[], capabilities = allKinds) {
  const onPredicatesChange = vi.fn();
  const onJudgeConfigChange = vi.fn();
  const utils = render(
    <SuiteScorerTable
      scope={{ kind: "suite", predicates, onPredicatesChange }}
      judgeConfig={undefined}
      onJudgeConfigChange={onJudgeConfigChange}
      capabilities={capabilities}
      passOrFailHint={PASS_OR_FAIL_HINT}
      judgeHint={JUDGE_HINT}
    />,
  );
  const next = () => {
    const arg = onPredicatesChange.mock.calls.at(-1)?.[0];
    return typeof arg === "function" ? arg(predicates) : arg;
  };
  return { ...utils, onPredicatesChange, onJudgeConfigChange, next };
}

function renderCase(
  suitePredicates: Predicate[],
  draft: StandardCheckDraft,
  overrides: {
    capabilities?: SuiteCapabilities;
    judgeConfig?: Parameters<typeof SuiteScorerTable>[0]["judgeConfig"];
    judgeSkipped?: boolean;
  } = {},
) {
  const onDraftChange = vi.fn();
  const onJudgeSkippedChange = vi.fn();
  const utils = render(
    <SuiteScorerTable
      scope={{
        kind: "case",
        suitePredicates,
        draft,
        onDraftChange,
        judgeSkipped: overrides.judgeSkipped ?? false,
        onJudgeSkippedChange,
      }}
      judgeConfig={overrides.judgeConfig}
      capabilities={overrides.capabilities ?? allKinds}
      passOrFailHint={PASS_OR_FAIL_HINT}
      judgeHint={JUDGE_HINT}
    />,
  );
  return { ...utils, onDraftChange, onJudgeSkippedChange };
}

describe("suite scope", () => {
  it("switches a preset on by appending it and a rule off by removing it", async () => {
    const user = userEvent.setup();
    const { next } = renderSuite([{ type: "noToolErrors" }]);
    await user.click(screen.getByRole("checkbox", { name: latency.name }));
    expect(next()).toEqual([{ type: "noToolErrors" }, latency.preset]);
    await user.click(screen.getByRole("checkbox", { name: errors.name }));
    expect(next()).toEqual([]);
  });

  it("paints a clickable off check in foreground text and a locked one muted", () => {
    const { container } = renderSuite([], {
      scorers: { predicateKinds: ["toolDescriptionsPresent"] },
    } as SuiteCapabilities);
    const description = row(container, "preset:discovery.description");
    expect(description.className).toContain("text-foreground");
    expect(description.className).not.toContain("text-muted-foreground");
    expect(
      within(description).getByRole("checkbox", { name: "Description quality" }),
    ).toBeEnabled();
    expect(row(container, "preset:discovery.annotations").className).toContain(
      "text-muted-foreground",
    );
    expect(row(container, "observed:discovery").className).toContain(
      "text-muted-foreground",
    );
  });

  it("keeps a preset the deployment cannot accept off, and says why", () => {
    const { container } = renderSuite([], {
      scorers: { predicateKinds: ["noToolErrors"] },
    } as SuiteCapabilities);
    expect(screen.getByRole("checkbox", { name: latency.name })).toBeDisabled();
    expect(
      within(row(container, `preset:${latency.id}`)).getByText(
        BACKEND_SUPPORT_HINT,
      ),
    ).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: errors.name })).toBeEnabled();
  });

  it("names a family row by its standard check, with the criterion under it", async () => {
    const user = userEvent.setup();
    const { container } = renderSuite([{ type: "toolLatencyUnder", ms: 1234 }]);
    const latencyRow = row(container, "predicate:0");
    expect(latencyRow).toHaveAttribute("data-scorer-enabled", "true");
    expect(within(latencyRow).getByText(latency.name)).toBeInTheDocument();
    expect(within(latencyRow).getByText(latency.label)).toBeInTheDocument();
    expect(within(latencyRow).queryByText(/1,234/)).toBeNull();
    // On, so no second preset row for the same family.
    expect(row(container, `preset:${latency.id}`)).toBeNull();
    expect(
      within(latencyRow).queryByRole("button", { name: latency.name }),
    ).toBeNull();
    await user.click(screen.getByRole("button", { name: "Edit evaluators" }));
    expect(
      within(latencyRow).getByRole("spinbutton", {
        name: "Max time in ms (strictly under)",
      }),
    ).toHaveValue(1234);
  });

  it("writes the judge's enabled flag from its On box", async () => {
    const user = userEvent.setup();
    const { onJudgeConfigChange } = renderSuite([]);
    const judge = screen.getByRole("checkbox", {
      name: "Goal completion judge",
    });
    expect(judge).toBeChecked();
    await user.click(judge);
    expect(onJudgeConfigChange).toHaveBeenCalledWith({
      goalCompletion: { enabled: false },
    });
  });
});

describe("case scope", () => {
  it("lists inherited rules read-only and the case's own editable, in that order", async () => {
    const user = userEvent.setup();
    const { container } = renderCase([{ type: "toolLatencyUnder", ms: 1234 }], {
      predicates: {
        mode: "extend",
        list: [{ type: "turnCountUnder", turns: 3 }],
      },
    });
    const inherited = row(container, "predicate:0");
    expect(inherited).toHaveAttribute("data-scorer-source", "suite");
    expect(within(inherited).queryByText("From suite")).toBeNull();
    await user.click(screen.getByRole("button", { name: "Edit evaluators" }));
    expect(within(inherited).queryByRole("spinbutton")).toBeNull();
    expect(within(inherited).getByText(latency.label)).toBeInTheDocument();
    const own = row(container, "predicate:1");
    expect(own).toHaveAttribute("data-scorer-source", "case");
    expect(within(own).getByText("This case")).toBeInTheDocument();
    expect(
      within(own).getByRole("spinbutton", {
        name: "User turns (strictly under)",
      }),
    ).toHaveValue(3);
    expect(
      within(own).getByRole("button", { name: "Advisory" }),
    ).toBeInTheDocument();
  });

  it("suppresses an inherited family and says how many rules that covers", async () => {
    const user = userEvent.setup();
    const { container, onDraftChange } = renderCase(
      [
        { type: "toolLatencyUnder", ms: 1234 },
        { type: "toolLatencyUnder", ms: 9999, role: "advisory" },
      ],
      {},
    );
    expect(
      within(row(container, "predicate:0")).getByText(
        "Turns off all 2 suite assertions of this kind for this case.",
      ),
    ).toBeInTheDocument();
    const boxes = screen.getAllByRole("checkbox", { name: latency.name });
    expect(boxes).toHaveLength(2);
    await user.click(boxes[0]);
    expect(onDraftChange).toHaveBeenCalledWith({
      predicates: undefined,
      suppressedSuiteStandardCheckIds: [latency.id],
    });
  });

  it("cannot turn off an inherited rule outside any family, and says so", () => {
    const { container } = renderCase(
      [{ type: "responseContains", value: "ok" } as Predicate],
      {},
    );
    const inherited = row(container, "predicate:0");
    expect(within(inherited).getByRole("checkbox")).toBeDisabled();
    expect(
      within(inherited).getByText(
        /Only standard assertions can be turned off per case/,
      ),
    ).toBeInTheDocument();
  });

  it("turns off an inherited family even when capabilities omit the flag", async () => {
    const user = userEvent.setup();
    const { onDraftChange } = renderCase([latency.preset], {}, {
      capabilities: {
        scorers: { predicateKinds: [latency.preset.type] },
      } as SuiteCapabilities,
    });
    const box = screen.getByRole("checkbox", { name: latency.name });
    expect(box).toBeEnabled();
    await user.click(box);
    expect(onDraftChange).toHaveBeenCalledWith({
      predicates: undefined,
      suppressedSuiteStandardCheckIds: [latency.id],
    });
  });

  it("removes and edits the case's own rules, and adds through the library", async () => {
    const user = userEvent.setup();
    const draft: StandardCheckDraft = {
      predicates: {
        mode: "extend",
        list: [{ type: "turnCountUnder", turns: 3 }],
      },
    };
    const { onDraftChange } = renderCase([], draft);
    await user.click(
      screen.getByRole("checkbox", {
        name: STANDARD_ASSERTION_CHECKS.find((c) => c.id === "userValue.turns")!
          .name,
      }),
    );
    expect(onDraftChange).toHaveBeenLastCalledWith({
      predicates: { mode: "extend", list: [] },
      suppressedSuiteStandardCheckIds: [],
    });
    await user.click(
      within(
        screen.getByRole("checkbox", {
          name: STANDARD_ASSERTION_CHECKS.find(
            (c) => c.id === "userValue.turns",
          )!.name,
        }).closest("li") as HTMLElement,
      ).getByRole("button", { name: "Advisory" }),
    );
    expect(onDraftChange).toHaveBeenLastCalledWith({
      predicates: {
        mode: "extend",
        list: [{ type: "turnCountUnder", turns: 3, role: "advisory" }],
      },
      suppressedSuiteStandardCheckIds: [],
    });
    await user.click(screen.getByRole("button", { name: "Add assertion" }));
    await user.click(
      await screen.findByTestId("add-step-item-check:noToolErrors"),
    );
    expect(onDraftChange).toHaveBeenLastCalledWith({
      predicates: {
        mode: "extend",
        list: [
          { type: "turnCountUnder", turns: 3 },
          expect.objectContaining({ type: "noToolErrors" }),
        ],
      },
      suppressedSuiteStandardCheckIds: [],
    });
  });

  it("says when the case replaces the suite's rules and lists none of them", () => {
    const { container } = renderCase([latency.preset], {
      predicates: { mode: "replace", list: [] },
    });
    expect(screen.getByTestId("case-replaces-suite-rules")).toBeInTheDocument();
    expect(container.querySelector('[data-scorer-source="suite"]')).toBeNull();
    // The family is unauthored here, so it is offered as a preset again.
    expect(row(container, `preset:${latency.id}`)).not.toBeNull();
  });

  it("reads the judge as the case's skip flag, and cannot revive a judge the suite turned off", async () => {
    const user = userEvent.setup();
    const judged = renderCase(
      [],
      {},
      { judgeConfig: { goalCompletion: { threshold: 0.7 } } },
    );
    // Read-only threshold and role: the suite's, not the case's to edit.
    expect(screen.getByText(/threshold 0\.7/i)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Edit evaluators" }));
    expect(
      screen.queryByRole("spinbutton", { name: "Judge threshold" }),
    ).toBeNull();
    judged.unmount();

    const skipped = renderCase(
      [],
      {},
      {
        judgeConfig: { goalCompletion: { threshold: 0.7 } },
        judgeSkipped: true,
      },
    );
    const box = screen.getByRole("checkbox", { name: "Goal completion judge" });
    expect(box).not.toBeChecked();
    // Off says only its name.
    expect(screen.queryByText(/threshold 0\.7/i)).toBeNull();
    await user.click(box);
    expect(skipped.onJudgeSkippedChange).toHaveBeenCalledWith(false);
    skipped.unmount();

    const off = renderCase(
      [],
      {},
      {
        judgeConfig: { goalCompletion: { enabled: false } },
      },
    );
    expect(
      screen.getByRole("checkbox", { name: "Goal completion judge" }),
    ).toBeDisabled();
    expect(screen.getByText("The suite's judge is off.")).toBeInTheDocument();
    expect(off.onJudgeSkippedChange).not.toHaveBeenCalled();
  });
});
