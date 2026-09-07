import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  QUALITY_GATE_CLI_ENFORCEMENT,
  QUALITY_GATE_GITHUB_ENFORCEMENT,
  SuiteQualityGateSection,
} from "../suite-quality-gate-section";
import {
  DEPLOYMENT_REASON_COPY,
  PERMISSION_REASON_COPY,
} from "../capability-reasons";
import type { SuiteCapabilities } from "@/hooks/use-suite-capabilities";

function readyCapabilities(
  patch: Partial<SuiteCapabilities> = {},
): SuiteCapabilities {
  return {
    suiteId: "suite-1",
    organizationId: "org-1",
    permissions: {
      "suite.view": true,
      "suite.edit": true,
      "suite.configure": true,
      "suite.delete": true,
      "suite.schedule": true,
      "suite.environments": true,
      "run.launch": true,
      "gate.waive": true,
      "judge.review": true,
      "baseline.set": true,
    },
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
    judge: {
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
    },
    qualityGate: {
      storage: true,
      evaluator: true,
      githubEnforcement: false,
      previousRunBaseline: false,
    },
    revisionNumber: 1,
    ...patch,
  };
}

function renderGate(
  overrides: Partial<Parameters<typeof SuiteQualityGateSection>[0]> = {},
) {
  const onChange = vi.fn();
  const result = render(
    <SuiteQualityGateSection
      policy={undefined}
      onChange={onChange}
      capabilities={readyCapabilities()}
      capabilitiesState="ready"
      {...overrides}
    />,
  );
  return { ...result, onChange };
}

describe("SuiteQualityGateSection", () => {
  it("lets the absolute error switch work without a baseline", async () => {
    const user = userEvent.setup();
    const { onChange } = renderGate();
    expect(
      screen.getByRole("switch", { name: "Any gating scorer errored" }),
    ).toBeEnabled();
    expect(
      screen.getByRole("switch", { name: "No deterministic regressions" }),
    ).toBeDisabled();
    await user.click(
      screen.getByRole("switch", { name: "Any gating scorer errored" }),
    );
    expect(onChange).toHaveBeenCalledWith({ noGatingScoreErrors: true });
  });

  it("clears comparative fields when the baseline selector is cleared", async () => {
    const user = userEvent.setup();
    const { onChange } = renderGate({
      policy: {
        baseline: { kind: "run", runId: "run_abc" },
        maximumPassRateDrop: 0.03,
        noDeterministicRegressions: true,
        maximumP95LatencyIncreaseMs: 250,
        noGatingScoreErrors: true,
      },
    });
    await user.selectOptions(
      screen.getByLabelText("Quality gate baseline"),
      "none",
    );
    expect(onChange).toHaveBeenCalledWith({ noGatingScoreErrors: true });
  });

  it("keeps the comparative conditions while a baseline id is being retyped", async () => {
    // Backspacing the run id to retype it is mid-edit, not a choice of None.
    // Rebuilding the policy from one field there would silently discard the
    // ceilings the person set beside it.
    const user = userEvent.setup();
    const { onChange } = renderGate({
      policy: {
        baseline: { kind: "run", runId: "run_abc" },
        maximumPassRateDrop: 0.03,
        noDeterministicRegressions: true,
        maximumP95LatencyIncreaseMs: 250,
        noGatingScoreErrors: true,
      },
    });
    await user.clear(screen.getByLabelText("Baseline run id"));
    expect(onChange).toHaveBeenCalledWith({
      maximumPassRateDrop: 0.03,
      noDeterministicRegressions: true,
      maximumP95LatencyIncreaseMs: 250,
      noGatingScoreErrors: true,
    });
  });

  it("treats zero as a configured threshold", async () => {
    const user = userEvent.setup();
    const { onChange } = renderGate({
      policy: { baseline: { kind: "run", runId: "run_abc" } },
    });
    const drop = screen.getByLabelText(
      "Maximum gating scorer pass-rate drop",
    ) as HTMLInputElement;
    await user.clear(drop);
    await user.type(drop, "0");
    await user.tab();
    expect(onChange).toHaveBeenCalledWith({
      baseline: { kind: "run", runId: "run_abc" },
      maximumPassRateDrop: 0,
    });

    const latency = screen.getByLabelText(
      "Maximum p95 latency increase in milliseconds",
    );
    await user.clear(latency);
    await user.type(latency, "0");
    await user.tab();
    expect(onChange).toHaveBeenCalledWith({
      baseline: { kind: "run", runId: "run_abc" },
      maximumP95LatencyIncreaseMs: 0,
    });
  });

  it("hides Previous run unless the backend advertises it", () => {
    const hidden = renderGate();
    expect(
      hidden.container.querySelector('option[value="previous_completed"]'),
    ).toBeNull();
    hidden.unmount();

    const shown = renderGate({
      capabilities: readyCapabilities({
        qualityGate: {
          storage: true,
          evaluator: true,
          previousRunBaseline: true,
        },
      }),
    });
    expect(
      shown.container.querySelector('option[value="previous_completed"]'),
    ).toBeTruthy();
  });

  it("disables with permission copy when baseline.set is absent", () => {
    const { container } = renderGate({
      capabilities: readyCapabilities({
        permissions: {
          "suite.view": true,
          "suite.edit": true,
          "suite.configure": true,
          "suite.delete": true,
          "suite.schedule": true,
          "suite.environments": true,
          "run.launch": true,
          "gate.waive": true,
          "judge.review": true,
        },
      }),
    });
    expect(
      container.querySelector("[data-disabled-reason]")?.textContent,
    ).toBe(PERMISSION_REASON_COPY);
    expect(screen.getByLabelText("Quality gate baseline")).toBeDisabled();
  });

  it("disables with deployment copy when the evaluator capability is absent", () => {
    const { container } = renderGate({
      capabilities: readyCapabilities({ qualityGate: { storage: true } }),
    });
    expect(
      container.querySelector("[data-disabled-reason]")?.textContent,
    ).toBe(DEPLOYMENT_REASON_COPY);
  });

  it("degrades without stamping a reason when capabilities are unavailable", () => {
    const { container } = renderGate({
      capabilities: null,
      capabilitiesState: "unavailable",
    });
    expect(container.querySelector("[data-disabled-reason]")).toBeNull();
    expect(screen.getByLabelText("Quality gate baseline")).toBeDisabled();
    expect(container.textContent).toContain(DEPLOYMENT_REASON_COPY);
  });

  it("uses GitHub enforcement copy only when the capability is on", () => {
    const cli = renderGate();
    expect(cli.container.textContent).toContain(QUALITY_GATE_CLI_ENFORCEMENT);
    expect(cli.container.textContent).not.toContain("GitHub checks");
    cli.unmount();

    const github = renderGate({
      capabilities: readyCapabilities({
        qualityGate: {
          storage: true,
          evaluator: true,
          githubEnforcement: true,
        },
      }),
    });
    expect(github.container.textContent).toContain(
      QUALITY_GATE_GITHUB_ENFORCEMENT,
    );
  });

  it("keeps an unresolved run label honest", () => {
    renderGate();
    fireEvent.change(screen.getByLabelText("Quality gate baseline"), {
      target: { value: "run" },
    });
    expect(screen.getByText("No run selected")).toBeTruthy();
  });
});
