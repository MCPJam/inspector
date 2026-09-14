import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Predicate } from "@mcpjam/sdk/predicates";
import { SuiteScorerTable } from "../suite-scorer-table";
import { PASS_OR_FAIL_HINT, JUDGE_HINT } from "../suite-pass-or-fail-section";
import type { SuiteCapabilities } from "@/hooks/use-suite-capabilities";

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

describe("SuiteScorerTable", () => {
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
      expect(group.textContent).toContain("Measured by the runner");
      const details = group.querySelector("details");
      expect(details).toBeTruthy();
      expect(
        group.querySelector(`[data-testid="${stage}-facts"]`),
      ).toBeTruthy();
    }
  });

  it("drafts severity when a predicate is set to Warn", async () => {
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
    // The role control sits on the row; a rule with no fields opens nothing.
    expect(
      screen.queryByRole("button", { name: "No tool returns an error" }),
    ).toBeNull();
    await user.click(screen.getByRole("button", { name: "Warn" }));
    expect(nextPredicates()).toEqual([
      { type: "noToolErrors", role: "advisory", severity: "warn" },
    ]);
  });

  it("offers a judge Warn control only after C1 judges capabilities", async () => {
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
    await user.click(
      screen.getByRole("button", { name: "Goal completion judge" }),
    );
    const judgeRole = document.querySelector('[aria-label="Judge role"]');
    expect(within(judgeRole as HTMLElement).getByText("Warn")).toBeTruthy();
    await user.click(within(judgeRole as HTMLElement).getByText("Warn"));
    expect(onJudgeConfigChange).toHaveBeenCalledWith(
      expect.objectContaining({
        goalCompletion: expect.objectContaining({
          role: "advisory",
          severity: "warn",
        }),
      }),
    );
  });

  it("does not offer a judge Warn control", () => {
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
    fireEvent.click(
      screen.getByRole("button", { name: "Goal completion judge" }),
    );
    const judgeRole = container.querySelector('[aria-label="Judge role"]');
    expect(judgeRole).toBeTruthy();
    expect(within(judgeRole as HTMLElement).queryByText("Warn")).toBeNull();
    expect(within(judgeRole as HTMLElement).getByText("Gate")).toBeTruthy();
    expect(within(judgeRole as HTMLElement).getByText("Report")).toBeTruthy();
  });

  it("renders groundedness as a report chip with no gate toggle", () => {
    const { container } = renderTable();
    const row = container.querySelector(
      '[data-scorer-id="judge:groundedness"]',
    ) as HTMLElement;
    expect(row).toBeTruthy();
    expect(within(row).getByText("Report")).toBeTruthy();
    expect(within(row).queryByRole("group", { name: "Judge role" })).toBeNull();
    expect(screen.getByText(/Groundedness runs on demand/)).toBeTruthy();
    expect(screen.getByTestId("groundedness-not-yet-run")).toBeTruthy();
  });

  it("disables judge Gate with the panel's copy", () => {
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
    fireEvent.click(
      screen.getByRole("button", { name: "Goal completion judge" }),
    );
    const gate = screen
      .getAllByRole("button", { name: "Gate" })
      .find((button) => button.closest('[aria-label="Judge role"]'));
    expect(gate).toBeDisabled();
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

  it("degrades predicate Role to a read-only chip without checkPolicy", () => {
    const { container } = renderTable({
      predicates: [{ type: "noToolErrors" }],
    });
    expect(screen.queryByRole("group", { name: "Assertion role" })).toBeNull();
    const row = container.querySelector(
      '[data-scorer-id="predicate:0"]',
    ) as HTMLElement;
    expect(within(row).getByText("Gate")).toBeTruthy();
  });

  it("still reports an advisory check honestly when it cannot be edited", () => {
    // A suite file or the CLI can author `role: "advisory"` on a backend that
    // does not advertise check policy. Rendering that as "Gate" tells a reader
    // the check will fail their trial when it cannot. Not being able to EDIT a
    // role is not a reason to misreport it.
    const { container } = renderTable({
      predicates: [
        { type: "noToolErrors", role: "advisory", severity: "warn" } as never,
      ],
    });
    expect(screen.queryByRole("group", { name: "Assertion role" })).toBeNull();
    const row = container.querySelector(
      '[data-scorer-id="predicate:0"]',
    ) as HTMLElement;
    expect(within(row).getByText("Warn")).toBeTruthy();
    expect(within(row).queryByText("Gate")).toBeNull();
  });
});

describe("SuiteScorerTable — role colour", () => {
  it("gives Warn the one colour, because it is the role that must catch the eye", () => {
    // Gate is the default and reads as ordinary; Report is muted because
    // "recorded, changes nothing" is what muted means. Warn is the role whose
    // whole job is to be noticed without failing anything.
    const { container } = renderTable({
      predicates: [
        { type: "noToolErrors", role: "advisory", severity: "warn" } as never,
        { type: "noToolErrors", role: "advisory" } as never,
      ],
    });
    const warn = within(
      container.querySelector('[data-scorer-id="predicate:0"]') as HTMLElement,
    ).getByText("Warn");
    const report = within(
      container.querySelector('[data-scorer-id="predicate:1"]') as HTMLElement,
    ).getByText("Report");
    expect(warn.className).not.toBe(report.className);
    expect(warn.className).toMatch(/amber|warn/i);
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
  // Each row reads its number, and opens its own field from the title.
  const cases: [string, string, number][] = [
    [
      "Tool descriptions meet the minimum length",
      "Minimum description length",
      31,
    ],
    [
      "Tool latency stays below the configured limit",
      "Max time in ms (strictly under)",
      1234,
    ],
    [
      "Tool result size stays below the configured limit",
      "Max result size in bytes (strictly under)",
      64000,
    ],
    [
      "Tool call count stays below the configured limit",
      "Max tool calls (strictly under)",
      4,
    ],
  ];
  for (const [title, field, value] of cases) {
    fireEvent.click(screen.getByRole("button", { name: title }));
    expect(screen.getByRole("spinbutton", { name: field })).toHaveValue(value);
    fireEvent.click(screen.getByRole("button", { name: title }));
  }
});
