import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
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
  it("edits the absolute error switch, the only condition this page owns", async () => {
    const user = userEvent.setup();
    const { onChange } = renderGate();
    const errored = screen.getByRole("switch", {
      name: "Any required evaluator errored",
    });
    expect(errored).toBeEnabled();
    await user.click(errored);
    expect(onChange).toHaveBeenCalledWith({ noGatingScoreErrors: true });
  });

  it("no longer offers a baseline or the conditions that need one", () => {
    const { container } = renderGate({
      policy: { baseline: { kind: "run", runId: "run_abc" } },
    });
    expect(screen.queryByLabelText("Quality gate baseline")).toBeNull();
    expect(screen.queryByLabelText("Baseline run id")).toBeNull();
    expect(screen.queryByLabelText("Baseline commit SHA")).toBeNull();
    expect(
      screen.queryByLabelText("Maximum required evaluator pass-rate drop"),
    ).toBeNull();
    expect(
      screen.queryByRole("switch", { name: "No deterministic regressions" }),
    ).toBeNull();
    expect(
      screen.queryByLabelText("Maximum p95 latency increase in milliseconds"),
    ).toBeNull();
    expect(
      container.querySelector('[data-setting-key="qualityGateBaseline"]'),
    ).toBeNull();
  });

  /**
   * A comparison condition set through the API still gates this suite's runs.
   * The page cannot edit it any more, so it has to at least say it is there —
   * a page that lists only what it owns under-reports the gate that runs.
   */
  it("lists a stored comparison condition read-only rather than dropping it", () => {
    const { container, onChange } = renderGate({
      simplified: true,
      policy: {
        baseline: { kind: "run", runId: "baseline-run" },
        maximumPassRateDrop: 0.05,
        noDeterministicRegressions: true,
        maximumP95LatencyIncreaseMs: 100,
        noGatingScoreErrors: true,
      },
    });
    expect(onChange).not.toHaveBeenCalled();
    const readOnly = Array.from(
      container.querySelectorAll("[data-readonly='true']"),
    ).map((row) => row.textContent);
    expect(readOnly).toEqual([
      "Allowed drop5 pp",
      "Deterministic regressionsFail",
      "p95 latency increase100 ms",
    ]);
  });

  it("keeps the absolute condition editable on the simplified page", () => {
    const { container } = renderGate({ simplified: true, policy: undefined });
    expect(
      screen.getByRole("switch", { name: "Any required evaluator errored" }),
    ).toBeEnabled();
    expect(container.querySelector("[data-readonly='true']")).toBeNull();
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
    expect(container.querySelector("[data-disabled-reason]")?.textContent).toBe(
      PERMISSION_REASON_COPY,
    );
    expect(
      screen.getByRole("switch", { name: "Any required evaluator errored" }),
    ).toBeDisabled();
  });

  it("disables with deployment copy when the evaluator capability is absent", () => {
    const { container } = renderGate({
      capabilities: readyCapabilities({ qualityGate: { storage: true } }),
    });
    expect(container.querySelector("[data-disabled-reason]")?.textContent).toBe(
      DEPLOYMENT_REASON_COPY,
    );
  });

  it("degrades without stamping a reason when capabilities are unavailable", () => {
    const { container } = renderGate({
      capabilities: null,
      capabilitiesState: "unavailable",
    });
    expect(container.querySelector("[data-disabled-reason]")).toBeNull();
    expect(
      screen.getByRole("switch", { name: "Any required evaluator errored" }),
    ).toBeDisabled();
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
});
