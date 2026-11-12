import { describe, expect, it, vi } from "vitest";
import { renderWithProviders, screen, userEvent, within } from "@/test";
import type { EvalIteration, EvalSuiteRun } from "../../../evals/types";
import { buildRunResultsMatrix } from "../../run-results-matrix-model";
import {
  buildHeroPairings,
  type HeroPairingPass,
} from "../../run-verdict-hero-deltas";
import { NavRunLayout } from "../nav-run-layout";

function run(id: string, model: string): EvalSuiteRun {
  return {
    _id: id,
    suiteId: "suite-1",
    createdBy: "u1",
    runNumber: 4,
    runGroupId: "launch",
    configRevision: "1",
    configSnapshot: { tests: [], environment: { servers: [] } },
    status: "completed",
    createdAt: 1,
    namedHostId: "host-1",
    effectiveModelId: model,
  };
}

function rows(
  runId: string,
  model: string,
  title: string,
  outcomes: EvalIteration["result"][],
): EvalIteration[] {
  return outcomes.map((result, index) => ({
    _id: `${runId}-${title}-${index}`,
    createdBy: "u1",
    createdAt: 1,
    updatedAt: 2,
    iterationNumber: index + 1,
    status: result === "pending" ? "running" : "completed",
    result,
    resultSource: "reported",
    actualToolCalls: [],
    tokensUsed: 10,
    suiteRunId: runId,
    testCaseId: `case:${title}`,
    testCaseSnapshot: {
      title,
      query: title,
      provider: "openai",
      model,
      expectedToolCalls: [],
    },
  }));
}

const gpt = run("run-gpt", "gpt-5-mini");
const haiku = run("run-haiku", "claude-haiku-4.5");
const iterations = [
  ...rows("run-gpt", "gpt-5-mini", "Sketch a two-node flow", [
    "passed",
    "failed",
    "failed",
    "failed",
  ]),
  ...rows("run-gpt", "gpt-5-mini", "Draw a rectangle", ["passed", "passed"]),
  ...rows("run-haiku", "claude-haiku-4.5", "Sketch a two-node flow", [
    "passed",
    "passed",
  ]),
  ...rows("run-haiku", "claude-haiku-4.5", "Draw a rectangle", [
    "passed",
    "passed",
  ]),
];
const hostNamesById = new Map([["host-1", "MCPJam"]]);

function setup(runs: EvalSuiteRun[], previous?: EvalSuiteRun[]) {
  const matrix = buildRunResultsMatrix({
    run: runs[0],
    runs,
    iterations,
    hostNamesById,
  });
  const previousIterations = previous?.flatMap((prior) =>
    rows(prior._id, prior.effectiveModelId ?? "", "Draw a rectangle", [
      "passed",
      "passed",
      "passed",
      "passed",
    ]),
  );
  const pairings = buildHeroPairings({
    targets: matrix.targets,
    previousLaunch: previous ?? null,
    previousIterations: previousIterations ?? null,
  });
  const findings = vi.fn((picked: { key: string } | null) => (
    <div data-testid="findings-slot">{picked?.key ?? "all"}</div>
  ));
  const onOpenTestRun = vi.fn();
  const onEditTestCase = vi.fn();
  renderWithProviders(
    <NavRunLayout
      matrix={matrix}
      pairings={pairings}
      passThreshold={0.7}
      findings={findings}
      onOpenTestRun={onOpenTestRun}
      onEditTestCase={onEditTestCase}
    />,
  );
  return { matrix, pairings, findings, onOpenTestRun, onEditTestCase };
}

const showing = () =>
  within(
    screen.getByRole("group", { name: "Filter this run by client and model" }),
  );

describe("NavRunLayout", () => {
  it("with several targets: All models, one chip per target and the hint", () => {
    setup([gpt, haiku]);
    const chips = showing().getAllByRole("button");
    expect(chips.map((chip) => chip.textContent)).toEqual([
      "All models7/10",
      "MCPJam · gpt-5-mini3/6",
      "MCPJam · claude-haiku-4.54/4",
    ]);
    expect(chips[0]).toHaveAttribute("aria-pressed", "true");
    expect(
      showing().getByText("Click a model anywhere on this page to filter it."),
    ).toBeTruthy();
    expect(screen.getByText("Test run")).toBeTruthy();
    expect(screen.getAllByTestId("run-verdict-pairing")).toHaveLength(2);
  });

  it("with one target: its chip pressed and inert, no identity, no header row", () => {
    setup([run("solo", "gpt-5-mini")]);
    const chips = showing().getAllByRole("button");
    expect(chips).toHaveLength(1);
    expect(chips[0]).toHaveAttribute("aria-pressed", "true");
    expect(chips[0]).toHaveClass("pointer-events-none");
    expect(showing().queryByText(/Click a model/)).toBeNull();
    expect(screen.queryAllByTitle("Show only this model")).toHaveLength(0);
    expect(screen.queryByText("Test run")).toBeNull();
  });

  it("filters Stats, findings and Test runs together, and clears on a second pick", async () => {
    const user = userEvent.setup();
    const { matrix, findings, onOpenTestRun } = setup([gpt, haiku]);
    const gptTarget = matrix.targets[0];
    await user.click(showing().getByRole("button", { name: /gpt-5-mini/ }));
    expect(screen.getAllByTestId("run-verdict-pairing")).toHaveLength(1);
    expect(findings).toHaveBeenLastCalledWith(gptTarget);
    expect(screen.getByTestId("findings-slot")).toHaveTextContent(
      gptTarget.key,
    );
    expect(screen.queryByText("Test run")).toBeNull();
    await user.click(
      screen.getByRole("button", { name: "Open test run: Draw a rectangle" }),
    );
    expect(onOpenTestRun).toHaveBeenCalledWith(
      "case:Draw a rectangle",
      "gpt-5-mini",
    );
    await user.click(showing().getByRole("button", { name: /gpt-5-mini/ }));
    expect(screen.getAllByTestId("run-verdict-pairing")).toHaveLength(2);
    expect(findings).toHaveBeenLastCalledWith(null);
  });

  it("picks a target from its pairing in Stats", async () => {
    const user = userEvent.setup();
    setup([gpt, haiku]);
    const identities = screen.getAllByTitle("Show only this model");
    await user.click(identities[1]);
    expect(
      showing().getByRole("button", { name: /claude-haiku/ }),
    ).toHaveAttribute("aria-pressed", "true");
    expect(screen.getAllByTestId("run-verdict-pairing")).toHaveLength(1);
  });

  it("opens a test run without ?target= when all models show", async () => {
    const user = userEvent.setup();
    const { onOpenTestRun, onEditTestCase } = setup([gpt, haiku]);
    await user.click(screen.getByRole("button", { name: "Draw a rectangle" }));
    await user.click(
      screen.getByRole("button", { name: "Edit Test Case: Draw a rectangle" }),
    );
    expect(onOpenTestRun).toHaveBeenCalledWith("case:Draw a rectangle", null);
    expect(onEditTestCase).toHaveBeenCalledWith("case:Draw a rectangle");
  });

  it("switches between Results and Speed and cost", async () => {
    const user = userEvent.setup();
    setup([run("solo", "gpt-5-mini")]);
    const labels = () =>
      screen
        .getAllByTestId("run-verdict-pairing-stat")
        .map((cell) => cell.firstChild?.textContent);
    expect(labels()).toEqual(["Pass rate", "Passed", "Failed"]);
    await user.click(screen.getByRole("radio", { name: "Speed and cost" }));
    expect(labels()).toEqual(["P50", "P95", "Tokens", "Calls"]);
  });
});

describe("NavRunStats deltas", () => {
  function pairing(overrides: Partial<HeroPairingPass>): HeroPairingPass {
    return {
      key: "p",
      client: "MCPJam",
      model: "gpt-5-mini",
      passed: 9,
      failed: 3,
      pending: 0,
      cancelled: 0,
      total: 12,
      delta: { label: "−2", direction: "down", tone: "regression" },
      passRate: 75,
      passRateDelta: { label: "−17%", direction: "down", tone: "regression" },
      stats: {
        latencyP50Ms: null,
        latencyP95Ms: null,
        tokens: null,
        toolCalls: null,
      },
      statDeltas: {
        latencyP50: null,
        latencyP95: null,
        tokens: null,
        toolCalls: null,
      },
      previousRunNumber: 3,
      ...overrides,
    };
  }

  function renderPairing(value: HeroPairingPass) {
    const matrix = buildRunResultsMatrix({
      run: run("solo", "gpt-5-mini"),
      runs: [],
      iterations: [],
      hostNamesById,
    });
    renderWithProviders(
      <NavRunLayout
        matrix={matrix}
        pairings={[value]}
        passThreshold={0.7}
        findings={() => null}
        onOpenTestRun={vi.fn()}
        onEditTestCase={vi.fn()}
      />,
    );
  }

  it("writes pass-rate changes in points and labels them for a screen reader", () => {
    renderPairing(pairing({}));
    const chips = screen.getAllByTestId("run-verdict-stat-delta");
    expect(chips.map((chip) => chip.textContent)).toEqual(["−17 pts", "−2"]);
    expect(chips[0]).toHaveAttribute(
      "aria-label",
      "−17 pts, worse vs previous run",
    );
    expect(chips[0]).toHaveClass("text-destructive");
    expect(screen.getByText(/vs run #3/)).toHaveTextContent(
      "vs run #3 · green better, red worse",
    );
  });

  it("says No change for an unchanged value", () => {
    renderPairing(
      pairing({
        passRateDelta: { label: "=", direction: "same", tone: "same" },
        delta: { label: "+1", direction: "up", tone: "progress" },
      }),
    );
    const [same, better] = screen.getAllByTestId("run-verdict-stat-delta");
    expect(same).toHaveTextContent("No change");
    expect(same).toHaveAttribute("aria-label", "No change vs previous run");
    expect(better).toHaveAttribute("aria-label", "+1, better vs previous run");
  });

  it("shows no chips while iterations are pending, and the first-run footnote", () => {
    renderPairing(pairing({ pending: 2, previousRunNumber: null }));
    expect(screen.queryByTestId("run-verdict-stat-delta")).toBeNull();
    expect(
      screen.getByText("First run of this client and model."),
    ).toBeTruthy();
    expect(
      screen
        .getAllByTestId("run-verdict-pairing-stat")
        .map((cell) => cell.firstChild?.textContent),
    ).toEqual(["Pass rate", "Passed", "Failed", "Pending"]);
  });
});
