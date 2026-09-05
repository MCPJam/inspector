/**
 * Card states for a description experiment: drafting, ready, running,
 * and the four report readings the header is allowed to claim.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { DescriptionExperimentReport } from "@mcpjam/sdk/contract";

import type { EvalDescriptionExperiment } from "@/lib/apis/eval-description-experiment-api";
import { RunDescriptionExperimentCard } from "../run-description-experiment-card";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

afterEach(cleanup);

function report(
  over: Partial<DescriptionExperimentReport> = {},
): DescriptionExperimentReport {
  return {
    schemaVersion: 1,
    toolName: "get_user",
    population: "trial",
    primary: {
      outcomeSource: "deterministic",
      pooled: {
        original: { eligible: 10, passed: 3, failed: 7, exclusions: {} },
        rewrite: { eligible: 10, passed: 8, failed: 2, exclusions: {} },
        interval: { deltaPoints: 50, lowerPoints: 12.4, upperPoints: 72 },
        verdict: "improved",
        minSampleSize: 5,
        minEffectSize: 0.05,
      },
      perCase: [
        {
          aggregationKey: "case_a\u0000",
          original: { eligible: 10, passed: 3, failed: 7, exclusions: {} },
          rewrite: { eligible: 10, passed: 8, failed: 2, exclusions: {} },
          interval: { deltaPoints: 50, lowerPoints: 12.4, upperPoints: 72 },
          verdict: "improved",
          minSampleSize: 5,
          minEffectSize: 0.05,
        },
      ],
    },
    secondary: { expectedToolNotCalled: { original: 7, rewrite: 2 } },
    regression: {
      checked: true,
      otherCases: 2,
      regressed: [],
      status: "passed",
    },
    frozen: {
      model: ["anthropic/claude-haiku-4.5"],
      engine: "emulated",
      hostConfigId: "host_abcdef12zzzz",
      toolSnapshotHash: "cataloghashvalue",
      judgeConfigHash: "judgehashvalue",
      environmentReset: "none",
      equal: true,
    },
    assignment: { method: "concurrent_two_run", overlapVerified: true },
    evidenceLabel: "reproducible",
    reportOnly: true,
    ...over,
  };
}

function experiment(
  over: Partial<EvalDescriptionExperiment> = {},
): EvalDescriptionExperiment {
  return {
    id: "exp_1",
    suiteId: "suite_1",
    sourceRunId: "run_1",
    toolName: "get_user",
    status: "proposed",
    originalDescription: "Look up a user by id.",
    proposal: {
      description: "Fetch the user record for a known id. Prefer this over search_users when the id is already known.",
      proposalHash: "p1",
    },
    plan: {
      caseScope: "all",
      plannedTrials: 20,
      maxTrials: 200,
      judgeAutoRun: true,
    },
    ...over,
  };
}

function renderCard(
  exp: EvalDescriptionExperiment,
  onStart: () => void = vi.fn(),
) {
  return render(
    <RunDescriptionExperimentCard experiment={exp} onStart={onStart} />,
  );
}

describe("RunDescriptionExperimentCard", () => {
  it("is collapsed by default and names the proposing state", () => {
    renderCard(experiment({ status: "proposing", proposal: undefined }));
    const card = screen.getByTestId("description-experiment-card");
    expect(card).toHaveTextContent(
      "Description experiment · `get_user` · drafting a rewrite",
    );
    expect(screen.queryByText("Word diff")).toBeNull();
    expect(screen.queryByTestId("description-experiment-start")).toBeNull();
  });

  it("names a proposed rewrite without inventing a rate", () => {
    renderCard(experiment({ status: "proposed" }));
    expect(screen.getByTestId("description-experiment-card")).toHaveTextContent(
      "Description experiment · `get_user` · rewrite ready",
    );
  });

  it("names a running experiment", () => {
    renderCard(experiment({ status: "running" }));
    expect(screen.getByTestId("description-experiment-card")).toHaveTextContent(
      "Description experiment · `get_user` · running",
    );
    expect(screen.queryByTestId("description-experiment-start")).toBeNull();
  });

  it("says not enough trials when the interval is null", async () => {
    const user = userEvent.setup();
    renderCard(
      experiment({
        status: "completed",
        report: report({
          primary: {
            outcomeSource: "deterministic",
            pooled: {
              original: { eligible: 3, passed: 1, failed: 2, exclusions: {} },
              rewrite: { eligible: 3, passed: 2, failed: 1, exclusions: {} },
              interval: null,
              verdict: "insufficient_data",
              minSampleSize: 5,
              minEffectSize: 0.05,
            },
            perCase: [],
          },
        }),
      }),
    );
    const card = screen.getByTestId("description-experiment-card");
    expect(card).toHaveTextContent("not enough trials to say");
    expect(card).not.toHaveTextContent(/at least|at most/);
    await user.click(screen.getByRole("button", { name: /Description experiment/ }));
    const expanded = screen.getByTestId("description-experiment-card");
    expect(expanded).toHaveTextContent("not enough trials to say");
    expect(expanded.textContent).not.toMatch(/[+-]?\d+(\.\d+)? points/);
  });

  it("states an improved interval as the lower bound in points", async () => {
    const user = userEvent.setup();
    renderCard(
      experiment({
        status: "completed",
        report: report(),
      }),
    );
    const card = screen.getByTestId("description-experiment-card");
    expect(card).toHaveTextContent(
      "rewrite passed 8 of 10, original 3 of 10",
    );
    expect(card).toHaveTextContent("at least +12 points");
    expect(card).toHaveTextContent("Reproducible");
    expect(card).toHaveTextContent("report-only");

    await user.click(screen.getByRole("button", { name: /Description experiment/ }));
    expect(screen.getByText("no reset")).toBeInTheDocument();
    expect(screen.getByText("catalog catalogh")).toBeInTheDocument();
    expect(screen.getByText("judge judgehas")).toBeInTheDocument();
    expect(
      screen.getByText(/upstream server's state was not verified/),
    ).toBeInTheDocument();
    expect(screen.getByText("No other case flipped.")).toBeInTheDocument();
  });

  it("states a regression as the upper bound and lists flipped cases", async () => {
    const user = userEvent.setup();
    renderCard(
      experiment({
        status: "completed",
        report: report({
          primary: {
            outcomeSource: "deterministic",
            pooled: {
              original: { eligible: 10, passed: 8, failed: 2, exclusions: {} },
              rewrite: { eligible: 10, passed: 3, failed: 7, exclusions: {} },
              interval: { deltaPoints: -50, lowerPoints: -72, upperPoints: -12.2 },
              verdict: "regressed",
              minSampleSize: 5,
              minEffectSize: 0.05,
            },
            perCase: [],
          },
          regression: {
            checked: true,
            otherCases: 1,
            regressed: ["other_case\u0000"],
            status: "failed",
          },
        }),
      }),
    );
    expect(screen.getByTestId("description-experiment-card")).toHaveTextContent(
      "at most -12 points",
    );
    await user.click(screen.getByRole("button", { name: /Description experiment/ }));
    expect(screen.getByText(/1 other case flipped: other_case/)).toBeInTheDocument();
  });

  it("labels a controlled experiment and still caveats the upstream server", async () => {
    const user = userEvent.setup();
    renderCard(
      experiment({
        status: "completed",
        report: report({
          evidenceLabel: "controlled",
          frozen: {
            model: ["anthropic/claude-haiku-4.5"],
            engine: "emulated",
            environmentReset: "per_trial_sandbox",
            equal: true,
          },
        }),
      }),
    );
    expect(screen.getByTestId("description-experiment-card")).toHaveTextContent(
      "Controlled",
    );
    await user.click(screen.getByRole("button", { name: /Description experiment/ }));
    expect(screen.getByText("fresh computer per trial")).toBeInTheDocument();
    expect(
      screen.getByText(/upstream server's state was not verified/),
    ).toBeInTheDocument();
  });

  it("names the arms' differences as the report found them, and keeps the report's label", async () => {
    const user = userEvent.setup();
    renderCard(
      experiment({
        status: "completed",
        report: report({
          evidenceLabel: "reproducible",
          frozen: {
            model: ["anthropic/claude-haiku-4.5"],
            engine: "emulated",
            environmentReset: "per_trial_sandbox",
            equal: false,
            differences: ["hostConfigId", "toolSnapshotHash"],
          },
        }),
      }),
    );
    const card = screen.getByTestId("description-experiment-card");
    // One line collapsed, and the label is the report's.
    expect(card.textContent).not.toContain("\n");
    expect(card).toHaveTextContent("Reproducible");
    expect(card).not.toHaveTextContent("Controlled");
    await user.click(
      screen.getByRole("button", { name: /Description experiment/ }),
    );
    expect(
      screen.getByTestId("description-experiment-arms-differ"),
    ).toHaveTextContent("arms differ: hostConfigId, toolSnapshotHash");
    // Fresh computers per trial would earn Controlled if recomputed here;
    // the pill must still say what the report said.
    expect(
      screen.getByTestId("description-experiment-evidence-label"),
    ).toHaveTextContent("Reproducible (as reported)");
    expect(screen.queryByText("catalog catalogh")).toBeNull();
    expect(
      screen.getByText(/they differed on hostConfigId, toolSnapshotHash/),
    ).toBeInTheDocument();
  });

  it("shows no differences pill when the report found the arms equal", async () => {
    const user = userEvent.setup();
    renderCard(experiment({ status: "completed", report: report() }));
    await user.click(
      screen.getByRole("button", { name: /Description experiment/ }),
    );
    expect(
      screen.queryByTestId("description-experiment-arms-differ"),
    ).toBeNull();
    expect(
      screen.getByTestId("description-experiment-evidence-label"),
    ).toHaveTextContent("Reproducible (as reported)");
  });

  it("confirms a launch with planned trials, judge notice, and the cap", async () => {
    const user = userEvent.setup();
    const onStart = vi.fn();
    renderCard(experiment({ status: "proposed" }), onStart);
    await user.click(screen.getByRole("button", { name: /Description experiment/ }));
    await user.click(screen.getByTestId("description-experiment-start"));
    expect(screen.getByText(/20 trials in total/)).toBeInTheDocument();
    expect(screen.getByText(/cap of 200/)).toBeInTheDocument();
    expect(
      screen.getByText(/judge will auto-run on both arms/),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Run experiment" }));
    expect(onStart).toHaveBeenCalledTimes(1);
  });

  it("focuses the launch action when the confirm opens, so Enter launches", async () => {
    const user = userEvent.setup();
    const onStart = vi.fn();
    renderCard(experiment({ status: "proposed" }), onStart);
    await user.click(
      screen.getByRole("button", { name: /Description experiment/ }),
    );
    await user.click(screen.getByTestId("description-experiment-start"));
    const run = screen.getByRole("button", { name: "Run experiment" });
    await waitFor(() => expect(run).toHaveFocus());
    expect(screen.getByRole("button", { name: "Cancel" })).not.toHaveFocus();
    await user.keyboard("{Enter}");
    expect(onStart).toHaveBeenCalledTimes(1);
  });
});
