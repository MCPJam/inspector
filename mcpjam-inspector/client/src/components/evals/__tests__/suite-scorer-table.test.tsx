import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { USER_VALUE_STAGE_QUESTIONS } from "@mcpjam/sdk/contract";
import type { Predicate } from "@mcpjam/sdk/predicates";
import { SuiteScorerTable } from "../suite-scorer-table";
import { PASS_OR_FAIL_HINT, JUDGE_HINT } from "../suite-pass-or-fail-section";
import type { SuiteCapabilities } from "@/hooks/use-suite-capabilities";
import { GOAL_COMPLETION_DEFAULTS } from "@/shared/judge-defaults";

vi.mock("posthog-js/react", () => ({
  useFeatureFlagEnabled: () => true,
}));

function judgeCapabilities(
  patch: Partial<SuiteCapabilities["judge"]> = {},
): SuiteCapabilities["judge"] {
  return {
    gating: { enabled: false, reason: "not_enabled_on_deployment" },
    role: "advisory",
    hasRubric: false,
    agreement: {
      reviews: 0,
      agreements: 0,
      rate: null,
      lowerBound: null,
      threshold: 0.8,
      minReviews: 20,
      eligible: false,
      reasons: ["insufficient_reviews"],
    },
    acknowledgement: null,
    ...patch,
  };
}

function renderTable(
  overrides: {
    predicates?: Predicate[];
    judgeConfig?: Parameters<typeof SuiteScorerTable>[0]["judgeConfig"];
    capabilities?: SuiteCapabilities | null;
    unavailableReason?: string;
    stageFacts?: Parameters<typeof SuiteScorerTable>[0]["stageFacts"];
  } = {},
) {
  const onPredicatesChange = vi.fn();
  const onJudgeConfigChange = vi.fn();
  const onMatchOptionsChange = vi.fn();
  const result = render(
    <SuiteScorerTable
      matchOptions={undefined}
      onMatchOptionsChange={onMatchOptionsChange}
      scope={{
        kind: "suite",
        predicates: overrides.predicates ?? [],
        onPredicatesChange,
      }}
      judgeConfig={overrides.judgeConfig}
      onJudgeConfigChange={onJudgeConfigChange}
      availableModels={[]}
      stageFacts={overrides.stageFacts}
      capabilities={overrides.capabilities}
      unavailableReason={overrides.unavailableReason}
      passOrFailHint={PASS_OR_FAIL_HINT}
      judgeHint={JUDGE_HINT}
    />,
  );
  const nextPredicates = () => {
    const arg = onPredicatesChange.mock.calls.at(-1)?.[0];
    return typeof arg === "function" ? arg(overrides.predicates ?? []) : arg;
  };
  return { ...result, onPredicatesChange, onJudgeConfigChange, nextPredicates };
}

describe("SuiteScorerTable rubric checks", () => {
  /** A deployment that grades rubric checks, with this goal-judge policy. */
  function withRubricChecks(goalEnabled: boolean): SuiteCapabilities {
    return {
      judge: judgeCapabilities(),
      judges: {
        goalCompletion: {
          role: "advisory",
          template: { version: 1, hash: "t" },
          execution: "wired",
          calibration: judgeCapabilities().agreement,
          policy: {
            contractVersion: 4,
            effective: { ...GOAL_COMPLETION_DEFAULTS, enabled: goalEnabled },
            automatic: goalEnabled,
          },
        },
        groundedness: {
          role: "advisory",
          template: null,
          execution: "not_wired",
          calibration: "unavailable",
        },
        rubricChecks: {
          role: "advisory",
          template: { version: 1, hash: "r" },
          execution: "wired",
          calibration: "unavailable",
        },
      },
    } as unknown as SuiteCapabilities;
  }

  function rubricRow(container: HTMLElement) {
    return container.querySelector(
      '[data-scorer-id="judge:rubricChecks"]',
    ) as HTMLElement | null;
  }

  it("pauses the row when the deployment policy turns the goal judge off", () => {
    // The suite stores no `enabled`, so the policy decides — and rubric
    // checks ride that judge's job, so they are off with it.
    const { container } = renderTable({
      judgeConfig: undefined,
      capabilities: withRubricChecks(false),
    });
    const row = rubricRow(container);
    expect(row).toBeTruthy();
    expect(
      within(row!).getByTestId("on-disabled-reason").textContent,
    ).toContain("goal-completion judge, which is off");
    expect(within(row!).getByRole("checkbox")).toHaveProperty("disabled", true);
  });

  it("leaves the row switchable while the policy keeps the judge on", () => {
    const { container } = renderTable({
      judgeConfig: undefined,
      capabilities: withRubricChecks(true),
    });
    const row = rubricRow(container);
    expect(row).toBeTruthy();
    expect(within(row!).queryByTestId("on-disabled-reason")).toBeNull();
    expect(within(row!).getByRole("checkbox")).toHaveProperty(
      "disabled",
      false,
    );
  });
});

describe("SuiteScorerTable", () => {
  it("shows disabled checked boxes for required match rules", () => {
    const { container } = renderTable();
    const rows = container.querySelectorAll('[data-scorer-row="match"]');
    expect(rows.length).toBeGreaterThanOrEqual(2);
    for (const row of rows) {
      const checkbox = within(row as HTMLElement).getByRole("checkbox");
      expect(checkbox).toBeChecked();
      expect(checkbox).toBeDisabled();
    }
  });
  it("mounts muted observed rows with folded facts", () => {
    const { container } = renderTable({
      stageFacts: {
        connection: <div data-testid="connection-facts">connection facts</div>,
        discovery: <div data-testid="discovery-facts">discovery facts</div>,
      },
    });
    for (const stage of ["connection", "discovery"] as const) {
      const group = container.querySelector(
        `[data-stage-group="${stage}"]`,
      ) as HTMLElement;
      const observed = group.querySelector(
        '[data-scorer-row="observed"]',
      ) as HTMLElement;
      // A runner check decides nothing: Built-in, never Required.
      expect(observed.textContent).toContain("Built-in");
      expect(observed.textContent).not.toContain("Required");
      const details = group.querySelector("details");
      expect(details).toBeTruthy();
      expect(
        group.querySelector(`[data-testid="${stage}-facts"]`),
      ).toBeTruthy();
    }
  });

  it("writes advisory with no severity when a predicate is set to Advisory", async () => {
    const user = userEvent.setup();
    const predicates: Predicate[] = [{ type: "noToolErrors" }];
    const { nextPredicates } = renderTable({
      predicates,
      capabilities: {
        suiteId: "s",
        organizationId: "o",
        permissions: {} as SuiteCapabilities["permissions"],
        features: {
          computers: { enabled: true },
          environments: { enabled: true },
          skills: { enabled: true },
          "claude-code-harness": { enabled: true },
          "codex-harness": { enabled: true },
          "cursor-harness": { enabled: true },
          "grading-engine-mode": { enabled: true },
          scheduledEvals: { enabled: true },
        },
        verdictPolicyV2: {
          deploymentMode: "enforce",
          suiteMode: null,
          canUpgrade: true,
        },
        judge: judgeCapabilities(),
        scorers: { checkPolicy: true },
        revisionNumber: 1,
      },
    });
    await user.click(screen.getByRole("button", { name: "Edit evaluators" }));
    const assertionRole = screen.getByRole("group", { name: "Assertion role" });
    await user.click(
      within(assertionRole).getByRole("button", { name: "Advisory" }),
    );
    expect(nextPredicates()).toEqual([
      { type: "noToolErrors", role: "advisory" },
    ]);
  });

  it("writes an advisory judge with no severity, whatever the judges capability says", async () => {
    const user = userEvent.setup();
    const { onJudgeConfigChange } = renderTable({
      capabilities: {
        suiteId: "s",
        organizationId: "o",
        permissions: {} as SuiteCapabilities["permissions"],
        features: {
          computers: { enabled: true },
          environments: { enabled: true },
          skills: { enabled: true },
          "claude-code-harness": { enabled: true },
          "codex-harness": { enabled: true },
          "cursor-harness": { enabled: true },
          "grading-engine-mode": { enabled: true },
          scheduledEvals: { enabled: true },
        },
        verdictPolicyV2: {
          deploymentMode: "enforce",
          suiteMode: null,
          canUpgrade: true,
        },
        judge: judgeCapabilities({
          gating: { enabled: true },
          agreement: {
            reviews: 20,
            agreements: 18,
            rate: 0.9,
            lowerBound: 0.8,
            threshold: 0.8,
            minReviews: 20,
            eligible: true,
            reasons: [],
          },
        }),
        judges: {
          goalCompletion: {
            role: "advisory",
            template: { version: 1, hash: "t" },
            execution: "wired",
            calibration: judgeCapabilities().agreement,
          },
          groundedness: {
            role: "advisory",
            template: null,
            execution: "not_wired",
            calibration: "unavailable",
          },
        },
        scorers: { checkPolicy: true },
        revisionNumber: 1,
      },
    });
    await user.click(screen.getByRole("button", { name: "Edit evaluators" }));
    const judgeRole = document.querySelector('[aria-label="Judge role"]');
    expect(within(judgeRole as HTMLElement).getByText("Advisory")).toBeTruthy();
    await user.click(within(judgeRole as HTMLElement).getByText("Advisory"));
    const [next] = onJudgeConfigChange.mock.calls.at(-1)!;
    expect(next.goalCompletion).toMatchObject({ role: "advisory" });
    expect("severity" in next.goalCompletion).toBe(false);
  });

  it("offers the judge exactly two segments, whatever the capability advertises", () => {
    const { container } = renderTable({
      capabilities: {
        suiteId: "s",
        organizationId: "o",
        permissions: {} as SuiteCapabilities["permissions"],
        features: {
          computers: { enabled: true },
          environments: { enabled: true },
          skills: { enabled: true },
          "claude-code-harness": { enabled: true },
          "codex-harness": { enabled: true },
          "cursor-harness": { enabled: true },
          "grading-engine-mode": { enabled: true },
          scheduledEvals: { enabled: true },
        },
        verdictPolicyV2: {
          deploymentMode: "enforce",
          suiteMode: null,
          canUpgrade: true,
        },
        judge: judgeCapabilities({
          gating: { enabled: true },
          agreement: {
            reviews: 20,
            agreements: 18,
            rate: 0.9,
            lowerBound: 0.8,
            threshold: 0.8,
            minReviews: 20,
            eligible: true,
            reasons: [],
          },
        }),
        scorers: { checkPolicy: true },
        revisionNumber: 1,
      },
    });
    fireEvent.click(screen.getByRole("button", { name: "Edit evaluators" }));
    const judgeRole = container.querySelector('[aria-label="Judge role"]');
    expect(judgeRole).toBeTruthy();
    // Warn collapsed into Advisory, so there is no third tier for the
    // judge-severity capability to withhold.
    expect(within(judgeRole as HTMLElement).queryByText("Warn")).toBeNull();
    expect(within(judgeRole as HTMLElement).queryByText("Report")).toBeNull();
    expect(within(judgeRole as HTMLElement).getByText("Required")).toBeTruthy();
    expect(within(judgeRole as HTMLElement).getByText("Advisory")).toBeTruthy();
  });

  it("renders groundedness as an advisory chip with no role toggle", () => {
    const { container } = renderTable();
    const row = container.querySelector(
      '[data-scorer-id="judge:groundedness"]',
    ) as HTMLElement;
    expect(row).toBeTruthy();
    expect(within(row).queryByRole("button")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Edit evaluators" }));
    expect(within(row).getByText("Advisory")).toBeTruthy();
    expect(within(row).queryByRole("group", { name: "Judge role" })).toBeNull();
    expect(screen.getByText(/Groundedness runs on demand/)).toBeTruthy();
    expect(screen.getByTestId("groundedness-not-yet-run")).toBeTruthy();
  });

  it("disables the judge's Required segment with the panel's copy", () => {
    renderTable({
      capabilities: {
        suiteId: "s",
        organizationId: "o",
        permissions: {} as SuiteCapabilities["permissions"],
        features: {
          computers: { enabled: true },
          environments: { enabled: true },
          skills: { enabled: true },
          "claude-code-harness": { enabled: true },
          "codex-harness": { enabled: true },
          "cursor-harness": { enabled: true },
          "grading-engine-mode": { enabled: true },
          scheduledEvals: { enabled: true },
        },
        verdictPolicyV2: {
          deploymentMode: "enforce",
          suiteMode: null,
          canUpgrade: true,
        },
        judge: judgeCapabilities(),
        revisionNumber: 1,
      },
    });
    fireEvent.click(screen.getByRole("button", { name: "Edit evaluators" }));
    const required = screen
      .getAllByRole("button", { name: "Required" })
      .find((button) => button.closest('[aria-label="Judge role"]'));
    expect(required).toBeDisabled();
    expect(screen.getByTestId("judge-gate-disabled-reason").textContent).toBe(
      "Not available on this deployment",
    );
  });

  it("lists library categories that have kinds", async () => {
    const user = userEvent.setup();
    renderTable();
    await user.click(screen.getByRole("button", { name: "Add assertion" }));
    for (const name of [
      "Assertions · Discovery",
      "Assertions · Selection",
      "Assertions · Tool call",
      "Assertions · Response",
      "Assertions · User value",
      "Assertions · Budgets",
    ]) {
      expect(screen.getByRole("region", { name })).toBeInTheDocument();
    }
    expect(screen.queryByRole("region", { name: "Actions" })).toBeNull();
  });

  it("has no Last run or Trend column", () => {
    const { container } = renderTable();
    // A list, not a grid: no column headers to grow a Last run into.
    expect(container.querySelector("table")).toBeNull();
    expect(container.textContent).not.toMatch(/Last run/i);
    expect(container.textContent).not.toMatch(/Trend/i);
  });

  it("degrades the predicate role to a read-only chip without checkPolicy", () => {
    const { container } = renderTable({
      predicates: [{ type: "noToolErrors" }],
    });
    expect(screen.queryByRole("group", { name: "Assertion role" })).toBeNull();
    const row = container.querySelector(
      '[data-scorer-id="predicate:0"]',
    ) as HTMLElement;
    fireEvent.click(screen.getByRole("button", { name: "Edit evaluators" }));
    expect(within(row).getByText("Required")).toBeTruthy();
  });

  it("still reports an advisory check honestly when it cannot be edited", () => {
    // A suite file or the CLI can author `role: "advisory"` on a backend that
    // does not advertise check policy. Rendering that as "Required" tells a
    // reader the check will fail their trial when it cannot. Not being able to
    // EDIT a role is not a reason to misreport it.
    const { container } = renderTable({
      predicates: [
        { type: "noToolErrors", role: "advisory", severity: "warn" } as never,
      ],
    });
    expect(screen.queryByRole("group", { name: "Assertion role" })).toBeNull();
    const row = container.querySelector(
      '[data-scorer-id="predicate:0"]',
    ) as HTMLElement;
    fireEvent.click(screen.getByRole("button", { name: "Edit evaluators" }));
    expect(within(row).getByText("Advisory")).toBeTruthy();
    expect(within(row).queryByText("Required")).toBeNull();
  });
});

describe("SuiteScorerTable — role colour", () => {
  it("renders a stored severity identically to none, because it is one tier", () => {
    // These two rows used to be Warn and Report, told apart by an amber
    // highlight alone. Neither failed the iteration, so the reader was being
    // asked to learn a distinction the verdict never made.
    const { container } = renderTable({
      predicates: [
        { type: "noToolErrors", role: "advisory", severity: "warn" } as never,
        { type: "noToolErrors", role: "advisory" } as never,
      ],
    });
    fireEvent.click(screen.getByRole("button", { name: "Edit evaluators" }));
    const withSeverity = within(
      container.querySelector('[data-scorer-id="predicate:0"]') as HTMLElement,
    ).getByText("Advisory");
    const without = within(
      container.querySelector('[data-scorer-id="predicate:1"]') as HTMLElement,
    ).getByText("Advisory");
    expect(withSeverity.className).toBe(without.className);
  });
});

it("keeps each standard numeric criterion in its own editable field", () => {
  renderTable({
    predicates: [
      { type: "toolDescriptionsPresent", minLength: 31 },
      { type: "toolLatencyUnder", ms: 1234 },
      { type: "toolResultSizeUnder", maxBytes: 64000 },
      { type: "toolCallCountUnder", count: 4 },
    ],
  });
  // The number lives in the field Edit evaluators opens. The title is not a control.
  const cases: [string, string, number][] = [
    ["Description quality", "Minimum description length", 31],
    ["Tool latency", "Max time in ms (strictly under)", 1234],
    ["Payload size", "Max result size in bytes (strictly under)", 64000],
    ["Tool hops before the right tool", "Max tool calls (strictly under)", 4],
  ];
  for (const [title] of cases) {
    expect(screen.queryByRole("button", { name: title })).toBeNull();
  }
  fireEvent.click(screen.getByRole("button", { name: "Edit evaluators" }));
  for (const [, field, value] of cases) {
    expect(screen.getByRole("spinbutton", { name: field })).toHaveValue(value);
  }
});

it("enters edit mode when checking a box, including after the row is saved", () => {
  function Harness() {
    const [predicates, setPredicates] = useState<Predicate[]>([]);
    return (
      <SuiteScorerTable
        matchOptions={undefined}
        onMatchOptionsChange={() => {}}
        scope={{
          kind: "suite",
          predicates,
          onPredicatesChange: setPredicates,
        }}
        onJudgeConfigChange={() => {}}
        availableModels={[]}
        capabilities={
          {
            scorers: { predicateKinds: ["toolDescriptionsPresent"] },
          } as SuiteCapabilities
        }
        passOrFailHint={PASS_OR_FAIL_HINT}
        judgeHint={JUDGE_HINT}
      />
    );
  }
  render(<Harness />);
  expect(
    screen.getByRole("button", { name: "Edit evaluators" }),
  ).toHaveAttribute("aria-expanded", "false");
  expect(screen.queryByRole("button", { name: "Description quality" })).toBeNull();
  fireEvent.click(
    screen.getByRole("checkbox", { name: "Description quality" }),
  );
  expect(
    screen.getByRole("button", { name: "Close evaluators" }),
  ).toHaveAttribute("aria-expanded", "true");
  expect(
    screen.getByRole("spinbutton", { name: "Minimum description length" }),
  ).toBeEnabled();
});

it("shows short names at rest and allows multiple role editors to stay open", () => {
  const { container } = renderTable({
    predicates: [
      { type: "noToolErrors" },
      { type: "toolLatencyUnder", ms: 1234 },
    ],
  });
  for (const question of Object.values(USER_VALUE_STAGE_QUESTIONS))
    expect(screen.queryByText(question)).toBeNull();
  expect(
    screen.getByRole("heading", { name: "Evaluators" }),
  ).toBeInTheDocument();
  const row = container.querySelector(
    '[data-scorer-id="predicate:0"]',
  ) as HTMLElement;
  expect(
    within(row).getByRole("checkbox", { name: "Tool errors (isError)" }),
  ).toBeChecked();
  expect(within(row).getByText("No tool returns an error")).toBeInTheDocument();
  expect(within(row).queryByRole("group")).toBeNull();
  expect(
    within(row).queryByRole("button", { name: "Tool errors (isError)" }),
  ).toBeNull();
  fireEvent.click(
    within(row).getByRole("checkbox", { name: "Tool errors (isError)" }),
  );
  expect(screen.getByRole("button", { name: "Close evaluators" })).toHaveAttribute(
    "aria-expanded",
    "true",
  );
  expect(
    container.querySelectorAll("[data-scorer-editor]").length,
  ).toBeGreaterThan(1);
  expect(within(row).getByText("No tool returns an error")).toBeInTheDocument();
  expect(within(row).getByText("Required")).toBeInTheDocument();
});

it("opens every evaluator's settings from Edit evaluators, then closes them", () => {
  const { container } = renderTable({
    predicates: [
      { type: "noToolErrors" },
      { type: "toolLatencyUnder", ms: 1234 },
    ],
  });
  expect(container.querySelectorAll("[data-scorer-editor]")).toHaveLength(0);
  fireEvent.click(screen.getByRole("button", { name: "Edit evaluators" }));
  const ids = [
    ...container.querySelectorAll("[data-scorer-editor]"),
  ].map((node) => node.getAttribute("data-scorer-editor"));
  expect(ids).toEqual(
    expect.arrayContaining([
      "predicate:0",
      "predicate:1",
      "judge:goalCompletion",
      "judge:groundedness",
      "preset:discovery.description",
    ]),
  );
  expect(ids).not.toContain("observed:discovery");
  const description = container.querySelector(
    '[data-scorer-id="preset:discovery.description"]',
  ) as HTMLElement;
  expect(
    within(description).getByRole("spinbutton", {
      name: "Minimum description length",
    }),
  ).toBeDisabled();
  expect(
    container.querySelector('[data-setting-key="matchOptions"]'),
  ).toHaveAttribute("open");
  expect(container.querySelector('[data-setting-key="judge"]')).toHaveAttribute(
    "open",
  );
  fireEvent.click(screen.getByRole("button", { name: "Close evaluators" }));
  expect(container.querySelectorAll("[data-scorer-editor]")).toHaveLength(0);
  expect(
    container.querySelector('[data-setting-key="matchOptions"]'),
  ).not.toHaveAttribute("open");
  expect(
    container.querySelector('[data-setting-key="judge"]'),
  ).not.toHaveAttribute("open");
});
