/**
 * The expanded case: grouped failures, evidence, and an action per group.
 *
 * The grouping is the claim being tested. Ten iterations that missed the same
 * call are one piece of work; the body must say that rather than printing ten
 * near-identical blocks, and it must not merge two different reasons into one
 * recommendation.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { EvalRunDecisionDiagnostic } from "@mcpjam/sdk/contract";

import { PASS_WORDS } from "./pass-words";
import { RunCaseRowBody } from "../run-case-row-body";
import type { EvaluateCaseRow } from "../evaluate-case-row-model";
import type { EvalIteration } from "../../evals/types";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

function diagnostic(
  iterationId: string,
  reason: string,
): EvalRunDecisionDiagnostic {
  return {
    iterationId,
    iterationNumber: 1,
    title: "Draw and share a diagram",
    status: "completed",
    result: "failed",
    chain: {
      status: "verified",
      analyzerVersion: 8,
      firstFailedStage: "selection",
      stages: [
        { stage: "connection", state: "passed" },
        { stage: "discovery", state: "passed" },
        { stage: "selection", state: "failed", reason },
        { stage: "call", state: "notReached" },
        { stage: "response", state: "notReached" },
        { stage: "userValue", state: "notMeasured" },
      ],
    },
    expected: { toolNames: ["create_view", "export_to_excalidraw"] },
    observed: { toolNames: ["create_view"] },
    evidence: { runId: "r", iterationId, tracePath: "/t" },
    nextAction: "review tool selection and the tool catalog",
  } as unknown as EvalRunDecisionDiagnostic;
}

function row(overrides: Partial<EvaluateCaseRow> = {}): EvaluateCaseRow {
  return {
    key: "g1",
    title: "Draw and share a diagram",
    testCaseId: "tc_1",
    iterations: { passed: 6, total: 10 },
    verdict: { kind: "matched", variants: [] },
    mark: "failed",
    break: { kind: "brokeAt", stage: "selection", reason: "missingToolCall" },
    cells: [],
    coverage: {
      total: 10,
      loaded: 10,
      breaksByStage: {
        connection: 0,
        discovery: 0,
        selection: 3,
        call: 0,
        response: 0,
        userValue: 0,
      },
      withheld: 0,
      note: null,
    },
    p50Ms: 13800,
    opensIterationId: "it_1",
    diagnostic: null,
    failureGroups: [
      {
        key: "selection::missingToolCall",
        stage: "selection",
        reason: "missingToolCall",
        iterationIds: ["it_1", "it_2", "it_3"],
        representative: diagnostic("it_1", "missingToolCall"),
      },
    ],
    ...overrides,
  } as EvaluateCaseRow;
}

const ITERATIONS = [
  {
    _id: "it_1",
    status: "completed",
    result: "failed",
    actualToolCalls: [{ toolName: "create_view", arguments: {} }],
  },
] as unknown as EvalIteration[];

afterEach(cleanup);

describe("RunCaseRowBody", () => {
  it("counts the iterations a failure shape covers", () => {
    render(<RunCaseRowBody row={row()} iterations={ITERATIONS} />);
    expect(
      screen.getByText("3 iterations broke at Selection"),
    ).toBeInTheDocument();
    expect(
      screen.getByText("evidence below is from the first of them"),
    ).toBeInTheDocument();
  });

  it("shows expected against observed and marks what was never called", () => {
    render(<RunCaseRowBody row={row()} iterations={ITERATIONS} />);
    const marker = screen.getByText("never called");
    // The missing call is listed under Observed and marked, rather than being
    // silently absent from a list the reader would have to diff by eye. Its
    // name and the marker share one list item, so the assertion reads the item.
    expect(marker.closest("li")).toHaveTextContent(
      "export_to_excalidraw never called",
    );
  });

  it("keeps two different reasons as two recommendations", () => {
    render(
      <RunCaseRowBody
        row={row({
          failureGroups: [
            {
              key: "selection::missingToolCall",
              stage: "selection",
              reason: "missingToolCall",
              iterationIds: ["it_1", "it_2"],
              representative: diagnostic("it_1", "missingToolCall"),
            },
            {
              key: "selection::toolError",
              stage: "selection",
              reason: "toolError",
              iterationIds: ["it_3"],
              representative: diagnostic("it_3", "toolError"),
            },
          ],
        })}
        iterations={ITERATIONS}
      />,
    );
    expect(screen.getAllByText("What to change")).toHaveLength(2);
    expect(
      screen.getAllByRole("button", { name: /Copy fix prompt/ }),
    ).toHaveLength(2);
  });

  it("labels a judge-scored group as something to check, not to fix", () => {
    render(
      <RunCaseRowBody
        row={row({
          failureGroups: [
            {
              key: "userValue::judgeFailed",
              stage: "userValue",
              reason: "judgeFailed",
              iterationIds: ["it_1"],
              representative: diagnostic("it_1", "judgeFailed"),
            },
          ],
        })}
        iterations={ITERATIONS}
      />,
    );
    expect(screen.getByText("Worth checking")).toBeInTheDocument();
    expect(screen.queryByText("What to change")).toBeNull();
  });

  it("says plainly when a group establishes nothing about the server", () => {
    render(
      <RunCaseRowBody
        row={row({
          failureGroups: [
            {
              key: "none::providerError",
              stage: null,
              reason: "providerError",
              iterationIds: ["it_1"],
              representative: diagnostic("it_1", "providerError"),
            },
          ],
        })}
        iterations={ITERATIONS}
      />,
    );
    // The contract records no remedy for a provider failure, so the block is
    // absent rather than filled with a manufactured next step.
    expect(screen.queryByText("What to change")).toBeNull();
    expect(screen.queryByText("Worth checking")).toBeNull();
    expect(
      screen.getByText(/1 iteration did not complete, and no stage/),
    ).toBeInTheDocument();
  });

  it("warns that a single iteration says nothing about consistency", () => {
    render(
      <RunCaseRowBody
        row={row({ iterations: { passed: 0, total: 1 } })}
        iterations={ITERATIONS}
      />,
    );
    const nudge = screen.getByText(/ran once/);
    expect(nudge).toBeInTheDocument();
    expect(nudge.textContent).not.toMatch(PASS_WORDS);
  });

  it("renders route facts between failure groups and nudges", () => {
    render(
      <RunCaseRowBody
        row={row({ iterations: { passed: 0, total: 1 } })}
        iterations={ITERATIONS}
        catalogState="loaded"
        routeFacts={[
          {
            caseVariantKey: "tc_1\u0000",
            caseKey: "tc_1",
            routes: {
              population: "trial",
              totalTrials: 1,
              includedTrials: 1,
              exclusions: {},
              routes: [
                { pathKey: "create_view", trials: 1, passed: 0, failed: 1 },
              ],
              tags: {
                noToolCalled: {
                  state: "measured",
                  value: 0,
                  numerator: 0,
                  denominator: 1,
                  exclusions: {},
                },
                retried: {
                  state: "measured",
                  value: 0,
                  numerator: 0,
                  denominator: 1,
                  exclusions: {},
                },
                looping: {
                  state: "measured",
                  value: 0,
                  numerator: 0,
                  denominator: 1,
                  exclusions: {},
                },
              },
              loopedOn: [],
              endedWithQuestion: {
                state: "notMeasured",
                value: null,
                numerator: 0,
                denominator: 0,
                exclusions: {},
              },
            },
            mismatch: {
              state: "measured",
              gradeableTrials: 1,
              expected: [
                {
                  tool: "export_to_excalidraw",
                  expectedIn: 1,
                  notCalledIn: 1,
                  notCalledInFailed: 1,
                },
              ],
              unexpected: [],
              substitutions: [],
            },
          },
        ]}
      />,
    );
    expect(screen.getByTestId("route-facts-section")).toBeInTheDocument();
    expect(screen.getByText("Routes")).toBeInTheDocument();
    expect(screen.queryByTestId("route-facts-variant")).toBeNull();
  });

  it("offers a propose button for a missing catalog tool when the engine is emulated", () => {
    render(
      <RunCaseRowBody
        row={row()}
        iterations={ITERATIONS}
        descriptionExperiment={{
          catalogToolNames: new Set(["export_to_excalidraw", "create_view"]),
          engineSupported: true,
          onPropose: vi.fn(),
        }}
      />,
    );
    expect(
      screen.getByRole("button", {
        name: "Propose a description rewrite for `export_to_excalidraw`",
      }),
    ).toBeEnabled();
  });

  it("disables the propose button on a harness engine", () => {
    render(
      <RunCaseRowBody
        row={row()}
        iterations={ITERATIONS}
        descriptionExperiment={{
          catalogToolNames: new Set(["export_to_excalidraw"]),
          engineSupported: false,
          onPropose: vi.fn(),
        }}
      />,
    );
    const button = screen.getByRole("button", {
      name: "Propose a description rewrite for `export_to_excalidraw`",
    });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute(
      "title",
      "Not available for harness runs yet",
    );
    expect(
      screen.getByText("Not available for harness runs yet"),
    ).toBeInTheDocument();
  });

  it("dispatches one proposal for rapid clicks and holds the button until it settles", async () => {
    const user = userEvent.setup();
    let resolve!: () => void;
    const onPropose = vi.fn(
      () =>
        new Promise<void>((res) => {
          resolve = res;
        }),
    );
    render(
      <RunCaseRowBody
        row={row()}
        iterations={ITERATIONS}
        descriptionExperiment={{
          catalogToolNames: new Set(["export_to_excalidraw"]),
          engineSupported: true,
          onPropose,
        }}
      />,
    );
    const button = screen.getByRole("button", {
      name: "Propose a description rewrite for `export_to_excalidraw`",
    });
    await user.tripleClick(button);
    expect(onPropose).toHaveBeenCalledTimes(1);
    expect(button).toBeDisabled();
    // No harness note: the hold is about the request, not the engine.
    expect(screen.queryByText("Not available for harness runs yet")).toBeNull();

    await act(async () => {
      resolve();
      await Promise.resolve();
    });
    expect(button).toBeEnabled();
  });

  it("holds every propose button while the hook has a request out", () => {
    render(
      <RunCaseRowBody
        row={row()}
        iterations={ITERATIONS}
        descriptionExperiment={{
          catalogToolNames: new Set(["export_to_excalidraw"]),
          engineSupported: true,
          onPropose: vi.fn(),
          requestPending: true,
        }}
      />,
    );
    const button = screen.getByRole("button", {
      name: "Propose a description rewrite for `export_to_excalidraw`",
    });
    expect(button).toBeDisabled();
    expect(button).not.toHaveAttribute("title");
    expect(screen.queryByText("Not available for harness runs yet")).toBeNull();
  });

  it("does not offer a propose button when the missing tool is not in the snapshot", () => {
    render(
      <RunCaseRowBody
        row={row()}
        iterations={ITERATIONS}
        descriptionExperiment={{
          catalogToolNames: new Set(["create_view"]),
          engineSupported: true,
          onPropose: vi.fn(),
        }}
      />,
    );
    expect(
      screen.queryByRole("button", { name: /Propose a description rewrite/ }),
    ).toBeNull();
  });

  it("does not offer a propose button when the flag did not pass the prop", () => {
    render(<RunCaseRowBody row={row()} iterations={ITERATIONS} />);
    expect(
      screen.queryByRole("button", { name: /Propose a description rewrite/ }),
    ).toBeNull();
  });

  it("explains a case that passed only on its threshold", () => {
    render(
      <RunCaseRowBody
        row={row({
          mark: "passed",
          verdict: {
            kind: "matched",
            variants: [
              {
                aggregationKey: "k",
                verdict: "passed",
                passedTrials: 4,
                failedTrials: 1,
                configuredTrials: 5,
                effectivePassThreshold: 0.7,
                mixedVerdict: false,
              },
            ],
          },
        })}
        iterations={ITERATIONS}
      />,
    );
    expect(
      screen.getByText(
        /passed on its threshold: 4 of 5 iterations cleared 0.7/,
      ),
    ).toBeInTheDocument();
  });
});
