import { describe, expect, it } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import type { Predicate } from "@/shared/eval-matching";
import type { TestStep } from "@/shared/steps";
import type { EvalIteration } from "@/components/evals/types";
import { TrialScorecard } from "../case-scorecard/trial-scorecard";
import type { CaseScorecardInput } from "../case-scorecard/case-scorecard-model";
import { buildCaseScorecard } from "../case-scorecard/case-scorecard-model";

const steps: TestStep[] = [
  { id: "s1", kind: "prompt", prompt: "Who am I signed in as?" },
  {
    id: "a1",
    kind: "assert",
    assertion: { type: "toolCalledAtLeastOnce", toolName: "get_me" },
  },
  { id: "a2", kind: "assert", assertion: { type: "noToolErrors" } },
];

const authored: CaseScorecardInput = {
  steps,
  toolsChoice: "unset",
  predicates: {
    mode: "extend",
    list: [{ type: "finalAssistantMessageNonEmpty" } as Predicate],
  },
};

function iteration(metadata: Record<string, unknown> = {}): EvalIteration {
  return {
    _id: "it1",
    status: "completed",
    result: "passed",
    metadata,
  } as unknown as EvalIteration;
}

function renderCard(
  overrides: Partial<Parameters<typeof TrialScorecard>[0]> = {},
) {
  return render(
    <TrialScorecard
      authored={authored}
      iteration={iteration()}
      steps={steps}
      {...overrides}
    />,
  );
}

const rowFor = (label: string) =>
  screen
    .getAllByTestId("trial-scorecard-row")
    .find((row) => row.textContent?.includes(label))!;

/** The rail's stages, in the order it lists them. */
const railStages = () =>
  screen
    .queryAllByTestId("stage-rail-item")
    .map((item) => item.getAttribute("data-stage"));

const railItem = (stage: string) =>
  screen
    .getAllByTestId("stage-rail-item")
    .find((item) => item.getAttribute("data-stage") === stage)!;

/** The section on screen for a stage, or `null` when another one is open. */
const sectionFor = (stage: string) =>
  document.querySelector(`[data-stage-group="${stage}"]`) as HTMLElement | null;

const openStage = (stage: string) => fireEvent.click(railItem(stage));

/** The state word on the open section, or `undefined` when it has none. */
const stateWordIn = (section: HTMLElement) =>
  within(section).queryByTestId("scorecard-group-state")?.textContent;

describe("TrialScorecard", () => {
  it.each(["pending", "running"] as const)(
    "withholds stage results while %s and reveals them when complete",
    (status) => {
      const chain = {
        status: "verified",
        stages: [{ stage: "connection", state: "passed", reason: "observed" }],
      } as never;
      const { rerender } = renderCard({
        iteration: { ...iteration(), status },
        chain,
      });
      expect(screen.getByTestId("trial-scorecard-loading")).toHaveAttribute(
        "aria-busy",
        "true",
      );
      expect(screen.queryByTestId("scorecard-group-state")).toBeNull();
      expect(screen.queryByTestId("trial-scorecard-row")).toBeNull();
      rerender(
        <TrialScorecard
          authored={authored}
          iteration={iteration()}
          steps={steps}
          chain={chain}
        />,
      );
      expect(screen.queryByTestId("trial-scorecard-loading")).toBeNull();
      expect(screen.getByTestId("scorecard-group-state")).toHaveTextContent(
        "passed",
      );
    },
  );
  it("shows a skeleton before a live iteration exists", () => {
    renderCard({ iteration: null, isRunning: true });
    expect(screen.getByTestId("trial-scorecard-loading")).toBeInTheDocument();
  });
  it("opens on the break, and keeps the other stages one click away", () => {
    const chain = {
      status: "verified",
      firstFailedStage: "selection",
      stages: [
        {
          stage: "connection",
          state: "passed",
          reason: "impliedByLaterEvidence",
        },
        { stage: "selection", state: "failed", reason: "missingToolCall" },
        {
          stage: "userValue",
          state: "notReached",
          reason: "earlierStageFailed",
        },
      ],
    } as never;
    renderCard({ chain });
    // Chain order. Every stage the runner measures has its runner check, so
    // each gets a cell and a row, whether or not anything authored grades it;
    // `toolCalledAtLeastOnce` expects a call, which brings Tool call in.
    expect(railStages()).toEqual([
      "connection",
      "discovery",
      "selection",
      "call",
      "response",
      "userValue",
    ]);
    // The contract's first failed stage is open, and it is the only one open:
    // a failed stage whose rows recorded nothing says why from the chain.
    expect(
      Array.from(document.querySelectorAll("[data-stage-group]")).map((node) =>
        node.getAttribute("data-stage-group"),
      ),
    ).toEqual(["selection"]);
    const selection = sectionFor("selection")!;
    expect(stateWordIn(selection)).toBe("failed");
    expect(within(selection).getByTestId("stage-reason")).toHaveTextContent(
      "Failed because an expected tool call was never made.",
    );
    expect(railItem("selection")).toHaveAttribute("aria-pressed", "true");

    openStage("connection");
    const connection = sectionFor("connection")!;
    expect(stateWordIn(connection)).toBe("passed");
    // Nothing authored grades Connection; its runner check says what the
    // chain decided there, instead of a bare heading.
    const connectionRows = within(connection).queryAllByTestId(
      "trial-scorecard-row",
    );
    expect(connectionRows).toHaveLength(1);
    expect(connectionRows[0]).toHaveAttribute("data-state", "passed");
    expect(connectionRows[0]).toHaveTextContent("Successful connection");
    expect(connectionRows[0]).toHaveTextContent(
      "Passed because a later stage's success implies it.",
    );
    expect(sectionFor("selection")).toBeNull();
  });

  it("returns to the break when the pane swaps to another iteration", () => {
    const chain = {
      status: "verified",
      firstFailedStage: "selection",
      stages: [
        { stage: "connection", state: "passed", reason: "observed" },
        { stage: "selection", state: "failed", reason: "missingToolCall" },
      ],
    } as never;
    const { rerender } = renderCard({ chain });
    openStage("connection");
    expect(sectionFor("connection")).not.toBeNull();
    rerender(
      <TrialScorecard
        authored={authored}
        iteration={{ ...iteration(), _id: "it2" } as EvalIteration}
        steps={steps}
        chain={chain}
      />,
    );
    // A different iteration is a different chain: a carried selection would
    // open a stage this one may never have broken at.
    expect(sectionFor("connection")).toBeNull();
    expect(sectionFor("selection")).not.toBeNull();
  });

  it("files every evaluator under its stage once, in chain order", () => {
    renderCard();
    expect(screen.queryByText("Added assertions")).toBeNull();
    expect(screen.queryByRole("region", { name: "Added assertions" })).toBeNull();
    const keys = screen
      .getAllByTestId("trial-scorecard-row")
      .map((row) => row.getAttribute("data-row-key"));
    const authoredKeys = buildCaseScorecard(authored)
      .groups.flatMap((group) => group.rows)
      .map((row) => row.key);
    expect(keys).toEqual(authoredKeys);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("does not invent an empty-state line for a prompt-only case", () => {
    renderCard({
      authored: { steps: [steps[0]], toolsChoice: "unset" },
      steps: [steps[0]],
    });
    expect(screen.queryByText("No extra assertions added.")).toBeNull();
    expect(screen.queryByTestId("trial-scorecard-summary")).toBeNull();
  });

  it("shows the judge's recorded passing rationale without expanding a row", () => {
    renderCard({
      judgeCase: {
        status: "completed",
        passed: true,
        score: 1,
        reason:
          "The rendered diagram contains Begin, Decision, and End with connecting lines.",
      } as never,
    });
    expect(screen.getByTestId("user-value-pass-evidence")).toHaveTextContent(
      "The rendered diagram contains Begin, Decision, and End with connecting lines.",
    );
  });

  it("shows supporting stage evidence and stays quiet when there is none", async () => {
    const chain = {
      status: "verified",
      stages: [
        {
          stage: "userValue",
          state: "passed",
          evidence: {
            predicateReasons: ["All three diagram labels were visible."],
          },
        },
      ],
    } as never;
    const { rerender } = renderCard({ chain });
    expect(screen.getByTestId("user-value-pass-evidence")).toHaveTextContent(
      "All three diagram labels were visible.",
    );
    rerender(
      <TrialScorecard
        authored={authored}
        iteration={iteration()}
        steps={steps}
        chain={
          {
            status: "verified",
            stages: [{ stage: "userValue", state: "passed" }],
          } as never
        }
      />,
    );
    expect(screen.queryByTestId("user-value-pass-evidence")).toBeNull();
    expect(
      screen.queryByText(
        "This run recorded a pass without supporting evidence.",
      ),
    ).toBeNull();
  });

  it("does not reveal passing evidence during blind judge review", () => {
    renderCard({
      judgeHidden: true,
      judgeCase: {
        status: "completed",
        passed: true,
        score: 1,
        reason: "Private judge rationale",
      } as never,
    });
    expect(
      screen.queryByTestId("user-value-pass-evidence"),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText("Private judge rationale"),
    ).not.toBeInTheDocument();
  });

  it("says a scorer was not measured rather than showing it as passed", () => {
    renderCard();
    expect(rowFor("No tool errors so far")).toHaveAttribute(
      "data-state",
      "notMeasured",
    );
  });

  it("shows why a step failed, without a click", () => {
    renderCard({
      iteration: iteration({
        stepResults: [
          {
            stepId: "a2",
            stepIndex: 2,
            kind: "assert",
            status: "fail",
            reason: "get_me returned isError",
          },
        ],
      }),
    });
    const row = rowFor("No tool errors so far");
    expect(row).toHaveAttribute("data-state", "failed");
    expect(within(row).queryByRole("button")).toBeNull();
    expect(
      within(row).getByTestId("trial-scorecard-reason").textContent,
    ).toBe("get_me returned isError");
  });

  it("wears an advisory miss as a warning, and keeps it out of the gate count", () => {
    render(
      <TrialScorecard
        authored={{
          ...authored,
          predicates: {
            mode: "extend",
            list: [
              {
                type: "finalAssistantMessageNonEmpty",
                role: "advisory",
                severity: "warn",
              } as Predicate,
            ],
          },
        }}
        iteration={iteration({
          stepResults: [
            { stepId: "a2", stepIndex: 2, kind: "assert", status: "ok" },
          ],
          predicates: [
            {
              predicate: { type: "finalAssistantMessageNonEmpty" },
              passed: false,
              reason: "the answer was empty",
            },
          ],
        })}
        steps={steps}
      />,
    );
    const row = rowFor("Catch an empty answer");
    expect(row).toHaveAttribute("data-state", "failed");
    expect(row).toHaveAttribute("data-role", "advisory");
    expect(within(row).getByText("Missed · advisory")).toBeInTheDocument();
  });

  it("keeps the score-row view reachable but out of the way", () => {
    renderCard({ scoresSection: <div>score rows here</div> });
    const details = screen.getByTestId("iteration-score-rows");
    expect(details.tagName).toBe("DETAILS");
    expect(details).not.toHaveAttribute("open");
    expect(within(details).getByText("Score rows")).toBeInTheDocument();
  });

  it("hosts the judge's own panel as the judge row's body", () => {
    // Not a reimplementation: the panel owns the blind-label protocol, so
    // mounting it here is what keeps the protocol intact.
    renderCard({
      judgeSlot: <div data-testid="judge-panel">Judge score hidden</div>,
    });
    const judge = rowFor("Outcome achieved");
    expect(within(judge).getByTestId("judge-panel")).toBeInTheDocument();
  });

  it("never labels an unmeasured row with a pass word", () => {
    const { container } = renderCard();
    const unmeasured = screen
      .getAllByTestId("trial-scorecard-row")
      .filter((row) => row.getAttribute("data-state") === "notMeasured");
    expect(unmeasured.length).toBeGreaterThan(0);
    for (const row of unmeasured) {
      expect(within(row).getByText("Not measured")).toBeInTheDocument();
    }
    expect(container.textContent).not.toMatch(/toolCalledAtLeastOnce/);
  });
});

describe("the chain lives inside the Scorecard", () => {
  const chain = {
    status: "verified",
    stages: [
      { stage: "connection", state: "passed" },
      { stage: "discovery", state: "passed" },
      { stage: "selection", state: "failed", reason: "missingToolCall" },
      { stage: "call", state: "notReached" },
      { stage: "response", state: "notReached" },
      { stage: "userValue", state: "notReached" },
    ],
    firstFailedStage: "selection",
  } as never;

  it("gives every measured stage a heading with its state word", () => {
    renderCard({ chain });
    expect(railStages()).toEqual([
      "connection",
      "discovery",
      "selection",
      "call",
      "response",
      "userValue",
    ]);
    const states = [
      ["connection", "passed"],
      ["discovery", "passed"],
      ["selection", "failed"],
      ["call", "never ran (an earlier stage failed)"],
      ["response", "never ran (an earlier stage failed)"],
      ["userValue", "never ran (an earlier stage failed)"],
    ] as const;
    for (const [stage, word] of states) {
      openStage(stage);
      expect(stateWordIn(sectionFor(stage)!)).toBe(word);
    }
  });

  it("puts the state on the rail for a screen reader, not as a second word", () => {
    renderCard({ chain });
    // The dot is a colour; the word reaches a reader through the cell's name.
    expect(railItem("selection")).toHaveAttribute(
      "aria-label",
      "03 Selection: failed",
    );
    expect(railItem("connection")).toHaveAttribute(
      "aria-label",
      "01 Connection: Session connected",
    );
    // And the rail itself never prints it, so nothing says it twice.
    expect(screen.getByRole("navigation").textContent).not.toMatch(/failed/i);
  });

  it("explains a failed stage once, not once per source", () => {
    renderCard({ chain });
    const selection = sectionFor("selection")!;
    expect(within(selection).getByTestId("stage-reason")).toHaveTextContent(
      "Failed because an expected tool call was never made.",
    );
    expect(within(selection).queryByTestId("stage-floor")).toBeNull();
    // A stage that did not fail has no sentence of its own to add.
    openStage("connection");
    expect(
      within(sectionFor("connection")!).queryByTestId("stage-reason"),
    ).toBeNull();
  });

  it("shows no group state when the trial has no chain", () => {
    renderCard({});
    expect(screen.queryAllByTestId("scorecard-group-state")).toHaveLength(0);
    expect(screen.queryByTestId("stage-reason")).toBeNull();
    // No verified chain, no rail: the sections stack, and every one of them is
    // readable without a click that has nothing to key off.
    expect(railStages()).toEqual([]);
    expect(
      document.querySelectorAll("[data-stage-group]").length,
    ).toBeGreaterThan(1);
  });
});

describe("blind review hides the judge row's own output", () => {
  const judgeCase = {
    status: "completed",
    passed: false,
    score: 0.2,
    reason: "Private judge rationale",
  } as never;

  it("withholds the score and the reason", () => {
    renderCard({ judgeHidden: true, judgeCase });
    expect(screen.getByTestId("judge-result-withheld")).toBeTruthy();
    expect(screen.queryByText("Private judge rationale")).toBeNull();
  });

  it("withholds nothing when the judge never graded the trial", () => {
    // The model call failed, so there is no verdict to leak and no label
    // control to lift the mask. The stage's own explanation must show.
    const providerFailed = {
      status: "verified",
      stages: [
        { stage: "connection", state: "passed", reason: "observed" },
        { stage: "discovery", state: "passed", reason: "observed" },
        { stage: "selection", state: "passed", reason: "observed" },
        { stage: "call", state: "passed", reason: "observed" },
        { stage: "response", state: "notMeasured", reason: "providerError" },
        { stage: "userValue", state: "notMeasured", reason: "providerError" },
      ],
    } as never;
    renderCard({ chain: providerFailed, judgeHidden: true, judgeCase: null });
    expect(screen.queryByTestId("judge-result-withheld")).toBeNull();
    expect(screen.queryByTestId("trial-stage-masked")).toBeNull();
  });

  it("shows them once the reviewer has revealed", () => {
    renderCard({ judgeHidden: false });
    expect(screen.queryByTestId("judge-result-withheld")).toBeNull();
  });

  it("hides nothing on a non-judge row", () => {
    renderCard({ judgeHidden: true });
    const withheld = screen
      .getAllByTestId("trial-scorecard-row")
      .filter((row) =>
        row.querySelector('[data-testid="judge-result-withheld"]'),
      );
    // Only the judge row withholds; a deterministic check has no verdict to
    // leak and hiding it would just make the trial unreadable.
    expect(withheld.length).toBeLessThanOrEqual(1);
  });
});

describe("blind review keeps the chain and masks one card", () => {
  const stages = (userValue: Record<string, unknown>) =>
    [
      { stage: "connection", state: "passed", reason: "observed" },
      { stage: "discovery", state: "passed", reason: "observed" },
      { stage: "selection", state: "failed", reason: "missingToolCall" },
      { stage: "call", state: "passed", reason: "observed" },
      { stage: "response", state: "passed", reason: "observed" },
      { stage: "userValue", ...userValue },
    ] as never[];
  const judgeDecided = {
    status: "verified",
    firstFailedStage: "selection",
    stages: stages({
      state: "failed",
      reason: "judgeFailed",
      evidence: { judgeReasons: ["Private judge rationale"] },
    }),
  } as never;
  const assertionDecided = {
    status: "verified",
    firstFailedStage: "selection",
    stages: stages({ state: "passed", reason: "observed" }),
  } as never;
  const judgeCase = {
    status: "completed",
    passed: false,
    score: 0.2,
    reason: "Private judge rationale",
  } as never;

  it("keeps every stage, masks User value, and still withholds the judge row", () => {
    renderCard({ chain: judgeDecided, judgeHidden: true, judgeCase });
    // Every stage is still reachable, and User value is the one open: the
    // label control lives in its section, and the opening is a rule rather
    // than a consequence of which stage the judge decided.
    expect(railStages()).toHaveLength(6);
    const userValue = sectionFor("userValue")!;
    // No state word, no stage sentence, no tally: each would say the verdict.
    expect(within(userValue).queryByTestId("scorecard-group-state")).toBeNull();
    expect(within(userValue).queryByTestId("stage-reason")).toBeNull();
    expect(screen.queryByTestId("trial-scorecard-summary")).toBeNull();
    expect(screen.getByTestId("judge-result-withheld")).toBeTruthy();
    expect(screen.queryByText("Private judge rationale")).toBeNull();
    expect(screen.queryByText(/below the partial floor/)).toBeNull();
    expect(screen.queryByTestId("user-value-pass-evidence")).toBeNull();
    // Nor does its cell leak the verdict a red dot would publish.
    expect(railItem("userValue")).toHaveAttribute(
      "aria-label",
      "06 User value: hidden until you label this iteration",
    );
    // The other five stages are the runner's, and stay readable.
    openStage("selection");
    expect(stateWordIn(sectionFor("selection")!)).toBe("failed");
  });

  it("does not put the masked stage's state on its group heading", () => {
    renderCard({ chain: judgeDecided, judgeHidden: true, judgeCase });
    expect(stateWordIn(sectionFor("userValue")!)).toBeUndefined();
    // Selection's own failure is the runner's, and stays on its heading.
    openStage("selection");
    expect(stateWordIn(sectionFor("selection")!)).toBe("failed");
  });

  it("masks nothing when an assertion decided User value", () => {
    renderCard({ chain: assertionDecided, judgeHidden: true, judgeCase });
    const userValue = document.querySelector(
      '[data-stage-group="userValue"]',
    ) as HTMLElement;
    expect(within(userValue).getByTestId("scorecard-group-state")).toHaveTextContent(
      "passed",
    );
    // The judge row is still the judge's even when the chain was not, so its
    // own output is still withheld.
    expect(screen.getByTestId("judge-result-withheld")).toBeTruthy();
  });

  it("drops the mask once the reviewer has revealed", () => {
    renderCard({ chain: judgeDecided, judgeHidden: false, judgeCase });
    // With nothing to withhold the rail opens on the break again, and User
    // value reads as the judge decided it.
    expect(sectionFor("selection")).not.toBeNull();
    openStage("userValue");
    expect(stateWordIn(sectionFor("userValue")!)).toBe("failed");
    expect(screen.queryByTestId("judge-result-withheld")).toBeNull();
  });
});

describe("built-in runner checks on the run page", () => {
  const builtinRows = () =>
    screen
      .getAllByTestId("trial-scorecard-row")
      .filter((row) =>
        row.getAttribute("data-row-key")?.startsWith("builtin:"),
      );

  it("renders an old run with no chain: each runner check is not measured", () => {
    renderCard({ chain: { status: "absent" } as never });
    // No rail without a verified chain, so every section stacks.
    const rows = builtinRows();
    expect(rows.map((row) => row.getAttribute("data-row-key"))).toEqual([
      "builtin:connection",
      "builtin:discovery",
      "builtin:call",
      "builtin:response",
    ]);
    for (const row of rows) {
      expect(row).toHaveAttribute("data-state", "notMeasured");
      expect(row).toHaveTextContent("Not measured");
    }
  });

  it("renders a setup_failed run: nothing measured reads as an error", () => {
    renderCard({
      iteration: { ...iteration(), status: "setup_failed" } as EvalIteration,
      chain: {
        status: "verified",
        failureCategory: "setup",
        analyzerVersion: 12,
        stages: [
          "connection",
          "discovery",
          "selection",
          "call",
          "response",
          "userValue",
        ].map((stage) => ({
          stage,
          state: "notMeasured",
          reason: "setupAborted",
        })),
      } as never,
    });
    for (const stage of ["connection", "discovery", "call", "response"]) {
      openStage(stage);
      const row = within(sectionFor(stage)!).getAllByTestId(
        "trial-scorecard-row",
      )[0]!;
      expect(row).toHaveAttribute("data-row-key", `builtin:${stage}`);
      expect(row).toHaveAttribute("data-state", "error");
      expect(row).toHaveTextContent("Could not be evaluated");
      expect(row).toHaveTextContent(
        "The environment was never prepared, so the test never began.",
      );
    }
  });

  it("badges a runner check Built-in and gives it no role", () => {
    renderCard({
      chain: {
        status: "verified",
        analyzerVersion: 12,
        stages: [{ stage: "connection", state: "passed", reason: "observed" }],
      } as never,
    });
    openStage("connection");
    const row = within(sectionFor("connection")!).getByTestId(
      "trial-scorecard-row",
    );
    expect(within(row).getByTestId("runner-check-badge")).toHaveTextContent(
      "Built-in",
    );
    expect(row).toHaveTextContent("The run connects to its servers");
    expect(row).toHaveTextContent(
      "Passed because the evidence was inspected and the stage held.",
    );
    expect(row.textContent).not.toMatch(/required|advisory|assertion/i);
  });
});

describe("what the scorecard says about its AI explanations", () => {
  const verifiedChain = {
    status: "verified",
    stages: [
      { stage: "connection", state: "passed", reason: "observed" },
      { stage: "discovery", state: "passed", reason: "observed" },
      { stage: "selection", state: "passed", reason: "observed" },
      { stage: "call", state: "passed", reason: "observed" },
      { stage: "response", state: "failed", reason: "toolError" },
      { stage: "userValue", state: "failed", reason: "predicateFailed" },
    ],
  } as never;

  const toolErrorTrace = {
    messages: [
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call-1",
            toolName: "create_journey",
            result: {
              isError: true,
              content: [
                {
                  type: "text",
                  text: "VALIDATION_ERROR: A journey must target at least one host",
                },
              ],
            },
          },
        ],
      },
    ],
  };

  it("keeps the recorded page when analysis fails", () => {
    renderCard({
      chain: verifiedChain,
      trace: toolErrorTrace,
      report: {
        schemaVersion: 1,
        iterationId: "it1",
        runRevision: "r",
        builtAt: 0,
        status: "failed",
        reason: "trace_too_large",
        rows: [],
      } as never,
    });
    // The deterministic floor does not depend on the model having run.
    // The tool name renders as code, so assert on the words, not the marks.
    const floor = screen.getByTestId("stage-floor");
    expect(within(floor).getByText("create_journey").tagName).toBe("CODE");
    expect(floor).toHaveTextContent(
      "returned an error: VALIDATION_ERROR: A journey must target at least one host",
    );
  });

  it("quotes the server on a failed stage with no report at all", () => {
    renderCard({ chain: verifiedChain, trace: toolErrorTrace });
    expect(screen.getByTestId("stage-floor")).toHaveAttribute(
      "data-narrative-source",
      "recorded",
    );
  });

  it("yields the stage to an AI explanation rather than saying it twice", () => {
    renderCard({
      chain: verifiedChain,
      trace: toolErrorTrace,
      report: {
        schemaVersion: 1,
        iterationId: "it1",
        runRevision: "r",
        builtAt: 0,
        status: "ready",
        rows: [],
        stageNotes: [
          {
            stage: "response",
            actual: "The journey call was rejected for having no host.",
            citations: ["tc:call-1"],
          },
        ],
      } as never,
    });
    expect(screen.queryByTestId("stage-floor")).toBeNull();
    expect(
      screen.getByText("The journey call was rejected for having no host."),
    ).toBeVisible();
  });

  it("promises a reviewer nothing while they are labelling blind", () => {
    renderCard({
      chain: verifiedChain,
      trace: toolErrorTrace,
      judgeHidden: true,
      judgeCase: {
        status: "completed",
        passed: false,
        score: 0.2,
      } as never,
      report: {
        schemaVersion: 1,
        iterationId: "it1",
        runRevision: "r",
        builtAt: 0,
        status: "pending",
        progress: { done: 1, total: 4 },
        rows: [],
      } as never,
    });
    expect(screen.queryByTestId("stage-floor")).toBeNull();
  });
});
