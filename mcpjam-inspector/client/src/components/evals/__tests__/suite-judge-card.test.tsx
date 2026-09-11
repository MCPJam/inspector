import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import type { SuiteCapabilities } from "@/hooks/use-suite-capabilities";
import {
  GROUNDEDNESS_UNAVAILABLE_COPY,
  SuiteJudgeCard,
} from "../suite-judge-card";

const judgesCapabilities: NonNullable<SuiteCapabilities["judges"]> = {
  goalCompletion: {
    role: "advisory",
    template: { version: 3, hash: "abc" },
    execution: "wired",
    calibration: {
      reviews: 0,
      agreements: 0,
      rate: null,
      lowerBound: null,
      threshold: 0.8,
      minReviews: 20,
      eligible: false,
      reasons: ["insufficient_reviews"],
    },
  },
  groundedness: {
    role: "advisory",
    template: null,
    execution: "not_wired",
    calibration: "unavailable",
  },
};

describe("SuiteJudgeCard", () => {
  it("shares a card per slot and uses that slot's template", () => {
    const onChange = vi.fn();
    const { rerender } = render(
      <SuiteJudgeCard
        slot="goalCompletion"
        judgeConfig={{ goalCompletion: { enabled: true, autoRun: true } }}
        onJudgeConfigChange={onChange}
        availableModels={[]}
        judgesCapabilities={judgesCapabilities}
      />,
    );
    expect(screen.getByTestId("suite-judge-card-goalCompletion")).toBeTruthy();
    expect(screen.getByTestId("suite-judge-template-goalCompletion").textContent).toBe(
      "Template v3",
    );

    rerender(
      <SuiteJudgeCard
        slot="groundedness"
        judgeConfig={{ goalCompletion: { enabled: true } }}
        onJudgeConfigChange={onChange}
        availableModels={[]}
        judgesCapabilities={judgesCapabilities}
      />,
    );
    expect(screen.getByTestId("suite-judge-card-groundedness")).toBeTruthy();
    expect(screen.getByTestId("suite-judge-template-groundedness").textContent).toBe(
      "No template yet",
    );
    expect(
      screen.getByTestId("suite-judge-agreement-groundedness").textContent,
    ).toBe("Calibration unavailable");
  });

  it("shows stored run model, threshold, and summary", () => {
    render(
      <SuiteJudgeCard
        slot="groundedness"
        judgeConfig={undefined}
        onJudgeConfigChange={vi.fn()}
        availableModels={[]}
        judgesCapabilities={judgesCapabilities}
        groundednessEvidence={{
          result: {
            summary: "Two claims were unsupported.",
            generatedAt: 1,
            modelUsed: "openai/gpt-5-mini",
            threshold: 0.75,
            cases: [],
          },
          pending: false,
        }}
      />,
    );
    expect(screen.getByTestId("groundedness-run-model").textContent).toBe(
      "openai/gpt-5-mini",
    );
    expect(screen.getByTestId("groundedness-run-threshold").textContent).toBe(
      "0.75",
    );
    expect(screen.getByTestId("groundedness-run-summary").textContent).toBe(
      "Two claims were unsupported.",
    );
    expect(screen.getByText(GROUNDEDNESS_UNAVAILABLE_COPY)).toBeTruthy();
    expect(screen.queryByRole("combobox")).toBeNull();
    expect(screen.queryByRole("switch")).toBeNull();
    expect(screen.queryByRole("button", { name: /run judge/i })).toBeNull();
  });

  it("shows an honest not-yet-run state without authoring controls", () => {
    render(
      <SuiteJudgeCard
        slot="groundedness"
        judgeConfig={undefined}
        onJudgeConfigChange={vi.fn()}
        availableModels={[]}
        judgesCapabilities={judgesCapabilities}
      />,
    );
    expect(screen.getByTestId("groundedness-not-yet-run").textContent).toBe(
      "Not run yet",
    );
    expect(screen.getByText(GROUNDEDNESS_UNAVAILABLE_COPY)).toBeTruthy();
    expect(screen.queryByLabelText(/judge model/i)).toBeNull();
    expect(screen.queryByRole("switch")).toBeNull();
  });

  it("does not copy goal-completion template onto groundedness without C1", () => {
    render(
      <SuiteJudgeCard
        slot="groundedness"
        judgeConfig={undefined}
        onJudgeConfigChange={vi.fn()}
        availableModels={[]}
      />,
    );
    expect(screen.getByTestId("suite-judge-template-groundedness").textContent).toBe(
      "Template unavailable on this deployment",
    );
    expect(
      screen.getByTestId("suite-judge-agreement-groundedness").textContent,
    ).toBe("Calibration unavailable");
  });

  it("keeps goal-completion model and auto-run on the card", () => {
    render(
      <SuiteJudgeCard
        slot="goalCompletion"
        judgeConfig={{
          goalCompletion: { enabled: true, autoRun: true, judgeModel: "x" },
        }}
        onJudgeConfigChange={vi.fn()}
        availableModels={[]}
        judgesCapabilities={judgesCapabilities}
        judgeAccessory={<div data-testid="judge-gate-panel">gate</div>}
        rubricEditor={<div data-testid="judge-rubric">rubric</div>}
      />,
    );
    expect(
      screen.getByRole("switch", { name: /auto-grade every run/i }),
    ).toBeTruthy();
    expect(screen.getByTestId("judge-gate-panel")).toBeTruthy();
    expect(screen.getByTestId("judge-rubric")).toBeTruthy();
    expect(
      document.querySelector('[data-setting-key="judgeRubric"]'),
    ).toBeTruthy();
  });
});
