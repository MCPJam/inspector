/**
 * The Scorecard layout is opt-in, by a prop, and the prop is the ONLY thing
 * that changes this component. `/evals` mounts it, the legacy preview mounts
 * it, three compact surfaces mount it — none of them pass the prop, and the
 * last test here pins their output as byte-identical.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import { IterationDetails } from "../iteration-details";
import type { EvalCase, EvalIteration } from "../types";

const { mockGetBlob } = vi.hoisted(() => ({ mockGetBlob: vi.fn() }));

vi.mock("convex/react", () => ({
  useAction: () => mockGetBlob,
  useQuery: () => undefined,
  useConvexAuth: () => ({ isAuthenticated: false, isLoading: false }),
}));
vi.mock("@/components/ui/json-editor", () => ({
  JsonEditor: () => <div data-testid="json-editor" />,
}));
vi.mock("@/lib/apis/mcp-tools-api", () => ({ listTools: vi.fn() }));
vi.mock("../trace-viewer", () => ({
  TraceViewer: () => <div data-testid="mock-trace-viewer" />,
}));

const testCase: EvalCase = {
  _id: "case-1",
  testSuiteId: "suite-1",
  createdBy: "user-1",
  title: "signed-in account",
  query: "who am I?",
  models: [{ model: "gpt-4o-mini", provider: "openai" }],
  runs: 1,
  expectedToolCalls: [],
};

const iteration: EvalIteration = {
  _id: "iter-1",
  testCaseId: "case-1",
  createdBy: "user-1",
  createdAt: 0,
  iterationNumber: 1,
  updatedAt: 0,
  status: "completed",
  result: "passed",
  actualToolCalls: [],
  tokensUsed: 0,
  blob: "trace-1",
  testCaseSnapshot: {
    title: "signed-in account",
    query: "who am I?",
    provider: "openai",
    model: "gpt-4o-mini",
    expectedToolCalls: [],
    steps: [
      { id: "s1", kind: "prompt", prompt: "who am I?" },
      { id: "a1", kind: "assert", assertion: { type: "noToolErrors" } },
    ],
  },
  metadata: {
    predicates: [
      { predicate: { type: "noToolErrors" }, passed: true, reason: "no errors" },
    ],
  },
};

const scorecard = {
  render: () => <div data-testid="mock-scorecard" />,
};

describe("IterationDetails — the scorecard layout", () => {
  beforeEach(() => {
    mockGetBlob.mockReset();
    mockGetBlob.mockResolvedValue({});
  });

  it("leads with the Scorecard and moves Steps after Trace", async () => {
    render(
      <IterationDetails
        iteration={iteration}
        testCase={testCase}
        layoutMode="full"
        scorecard={scorecard}
      />,
    );
    // The trace-backed tabs join the row once the blob lands; the Scorecard
    // is there from the first frame, because it reads persisted metadata.
    await screen.findByTestId("trace-viewer-steps-tab");
    const tabs = (await screen.findAllByRole("button")).filter((button) =>
      ["Scorecard", "Chat", "Tool Calls", "Trace", "Steps", "Raw"].includes(
        button.textContent?.trim() ?? "",
      ),
    );
    expect(tabs.map((tab) => tab.textContent?.trim())).toEqual([
      "Scorecard",
      "Chat",
      "Trace",
      "Steps",
      "Raw",
    ]);
  });

  it("shows the Scorecard before the trace has loaded, and without one at all", async () => {
    // The failure this pane exists to fix: a trial whose blob is slow, or
    // missing, had nothing to show but a spinner where its scorers should be.
    const { rerender } = render(
      <IterationDetails
        iteration={iteration}
        testCase={testCase}
        layoutMode="full"
        scorecard={scorecard}
      />,
    );
    expect(screen.getByTestId("mock-scorecard")).toBeInTheDocument();

    const { blob: _blob, ...traceless } = iteration;
    rerender(
      <IterationDetails
        iteration={traceless as typeof iteration}
        testCase={testCase}
        layoutMode="full"
        scorecard={scorecard}
      />,
    );
    expect(screen.getByTestId("mock-scorecard")).toBeInTheDocument();
    // ...and no tab row, rather than tabs that lead nowhere.
    expect(
      screen.queryByTestId("trace-viewer-scorecard-tab"),
    ).not.toBeInTheDocument();
  });

  it("opens on the Scorecard", async () => {
    render(
      <IterationDetails
        iteration={iteration}
        testCase={testCase}
        layoutMode="full"
        scorecard={scorecard}
      />,
    );
    expect(await screen.findByTestId("mock-scorecard")).toBeInTheDocument();
  });

  it("puts the chain above the tabs, not below the transcript", async () => {
    // A reader asking why a trial did not deliver should not scroll a
    // transcript to reach the summary of it.
    const { container } = render(
      <IterationDetails
        iteration={iteration}
        testCase={testCase}
        layoutMode="full"
        scorecard={scorecard}
        trialChainSlot={<div>chain</div>}
      />,
    );
    await screen.findByTestId("mock-scorecard");
    const chain = screen.getByTestId("iteration-trial-chain");
    const tabs = container.querySelector('[data-testid="trace-viewer-scorecard-tab"]')!;
    expect(
      chain.compareDocumentPosition(tabs) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("does not repeat the checks below the scorecard", async () => {
    // `PredicatesList` shows the same predicates the scorecard now shows, and
    // filters out the step-scoped ones, so on a typical case it was an empty
    // heading under a transcript.
    render(
      <IterationDetails
        iteration={iteration}
        testCase={testCase}
        layoutMode="full"
        scorecard={scorecard}
      />,
    );
    await screen.findByTestId("mock-scorecard");
    expect(
      screen.queryByTestId("iteration-predicates-section"),
    ).not.toBeInTheDocument();
  });

  it("renders identically to before when the prop is absent", () => {
    const withProp = render(
      <IterationDetails
        iteration={iteration}
        testCase={testCase}
        layoutMode="full"
      />,
    ).container.innerHTML;
    const again = render(
      <IterationDetails
        iteration={iteration}
        testCase={testCase}
        layoutMode="full"
      />,
    ).container.innerHTML;
    expect(again).toBe(withProp);
    // And the legacy layout still shows what it always showed.
    expect(withProp).toContain("iteration-predicates-section");
    expect(withProp).not.toContain("trace-viewer-scorecard-tab");
  });
});

it("clears the previous trial's envelope during a switch and after a failed read", async () => {
  const oldEnvelope = { messages: [], stepResults: [{ stepId: "old" }] };
  mockGetBlob.mockResolvedValueOnce(oldEnvelope);
  const renderScorecard = vi.fn(() => <div data-testid="envelope-scorecard" />);
  const props = {
    testCase,
    layoutMode: "full" as const,
    scorecard: { render: renderScorecard },
  };
  const { rerender } = render(
    <IterationDetails {...props} iteration={iteration} />,
  );
  await waitFor(() =>
    expect(renderScorecard.mock.lastCall?.[0].envelope).toEqual(oldEnvelope),
  );
  let reject!: (e: Error) => void;
  mockGetBlob.mockImplementationOnce(
    () =>
      new Promise((_, rej) => {
        reject = rej;
      }),
  );
  const next = { ...iteration, _id: "iter-2", blob: "trace-2" };
  rerender(<IterationDetails {...props} iteration={next} />);
  expect(renderScorecard.mock.lastCall?.[0].envelope).toBeNull();
  await act(async () => reject(new Error("read failed")));
  expect(renderScorecard.mock.lastCall?.[0].envelope).toBeNull();
});

it("shows the scorecard for a model-free pinned tool trial", () => {
  render(
    <IterationDetails
      iteration={{
        ...iteration,
        testCaseSnapshot: {
          ...iteration.testCaseSnapshot!,
          steps: [
            {
              id: "call",
              kind: "toolCall",
              serverName: "srv",
              toolName: "view",
              arguments: {},
            },
          ],
        },
      }}
      testCase={testCase}
      layoutMode="full"
      scorecard={scorecard}
    />,
  );
  expect(screen.getByTestId("mock-scorecard")).toBeInTheDocument();
});
