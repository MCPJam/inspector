import { describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
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
      predicates={overrides.predicates ?? []}
      onPredicatesChange={onPredicatesChange}
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
    return typeof arg === "function"
      ? arg(overrides.predicates ?? [])
      : arg;
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
      expect(group.textContent).toContain("Observed by the runner");
      const details = group.querySelector("details");
      expect(details).toBeTruthy();
      expect(
        group.querySelector(`[data-testid="${stage}-facts"]`),
      ).toBeTruthy();
    }
  });

  it("marks the stage group when a chain card is selected", async () => {
    const user = userEvent.setup();
    const { container } = renderTable();
    await user.click(screen.getByTestId("stage-chain-card-selection"));
    const group = container.querySelector(
      '[data-stage-group="selection"]',
    ) as HTMLElement;
    expect(group.getAttribute("data-selected")).toBe("true");
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
    await user.click(screen.getByRole("button", { name: "Warn" }));
    expect(nextPredicates()).toEqual([
      { type: "noToolErrors", role: "advisory", severity: "warn" },
    ]);
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
    const judgeRole = container.querySelector('[aria-label="Judge role"]');
    expect(judgeRole).toBeTruthy();
    expect(within(judgeRole as HTMLElement).queryByText("Warn")).toBeNull();
    expect(within(judgeRole as HTMLElement).getByText("Gate")).toBeTruthy();
    expect(within(judgeRole as HTMLElement).getByText("Report")).toBeTruthy();
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
    const gate = screen.getAllByRole("button", { name: "Gate" }).find(
      (button) => button.closest('[aria-label="Judge role"]'),
    );
    expect(gate).toBeDisabled();
    expect(screen.getByTestId("judge-gate-disabled-reason").textContent).toBe(
      "Not available on this deployment",
    );
  });

  it("lists library categories that have kinds", async () => {
    const user = userEvent.setup();
    renderTable();
    await user.click(screen.getByRole("button", { name: "Add scorer" }));
    const library = screen.getByTestId("scorer-library");
    expect(
      library.querySelector('[data-library-category="selection"]'),
    ).toBeTruthy();
    expect(
      library.querySelector('[data-library-category="userValue"]'),
    ).toBeTruthy();
    expect(
      library.querySelector('[data-library-category="budget"]'),
    ).toBeTruthy();
    expect(
      library.querySelector('[data-library-category="response"]'),
    ).toBeNull();
  });

  it("has no Last run or Trend column", () => {
    const { container } = renderTable();
    const heads = Array.from(container.querySelectorAll("thead th")).map(
      (head) => head.textContent?.trim(),
    );
    expect(heads).toEqual(["Scorer", "Kind", "Threshold", "Role"]);
    expect(container.textContent).not.toMatch(/Last run/i);
    expect(container.textContent).not.toMatch(/Trend/i);
  });

  it("degrades predicate Role to a Gate chip without checkPolicy", () => {
    const { container } = renderTable({
      predicates: [{ type: "noToolErrors" }],
    });
    expect(screen.queryByRole("group", { name: "Check role" })).toBeNull();
    const row = container.querySelector(
      '[data-scorer-id="predicate:0"]',
    ) as HTMLElement;
    expect(within(row).getByText("Gate")).toBeTruthy();
  });
});
