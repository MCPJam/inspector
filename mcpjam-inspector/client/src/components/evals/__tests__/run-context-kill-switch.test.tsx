/**
 * `project-environments-enabled` OFF — the rollback kill switch.
 *
 * The posture these tests pin, and the reason they live in their own file (the
 * flag is mocked at module scope):
 *
 *   - environment NAMES and REVISIONS are gated. With the flag off, no
 *     environment identity may appear on ANY surface that renders a retained
 *     historical run — and in particular must not leak back in disguised as a
 *     host label, which is what happens when a "host" fallback re-derives its
 *     text from a helper that reads `environmentRef`;
 *   - the COUNT and the axis NOUN are NOT gated — they leak no identity, and
 *     gating them made the results rail and the flat runs list disagree about
 *     the same runs;
 *   - legacy host-backed runs keep exactly today's host label.
 */
import { describe, expect, it, vi } from "vitest";
import { renderWithProviders, screen } from "@/test";
import { SuiteRunsList } from "../suite-runs-list";
import { SuiteResultsSplit } from "../suite-results-split";
import { CaseRunsHistory } from "../runs/case-runs-history";
import {
  contextSuite,
  envRun,
  hostRun,
  oneEnvironmentThreeRuns,
  twoEnvironmentsOneGroup,
} from "./run-context-fixtures";
import type { EvalIteration } from "../types";

vi.mock("@/hooks/useProjectEnvironmentsEnabled", () => ({
  useProjectEnvironmentsEnabled: () => false,
  useProjectEnvironmentsEnabledState: () => false,
  PROJECT_ENVIRONMENTS_FEATURE_FLAG: "project-environments-enabled",
}));

/** No environment name and no revision, anywhere in the rendered tree. */
function expectNoEnvironmentIdentity() {
  expect(screen.queryByText("Staging")).not.toBeInTheDocument();
  expect(screen.queryByText("Prod")).not.toBeInTheDocument();
  expect(screen.queryByText(/rev \d/)).not.toBeInTheDocument();
  expect(document.body.textContent).not.toMatch(/Staging|Prod|rev \d/);
}

function renderRail(runs = twoEnvironmentsOneGroup) {
  return renderWithProviders(
    <SuiteResultsSplit
      suite={contextSuite}
      cases={[]}
      runs={runs}
      allIterations={[]}
      hostNamesById={new Map()}
      allRunsPane={<div />}
      onTestCaseClick={vi.fn()}
      onRunClick={vi.fn()}
    />
  );
}

describe("kill switch off — no environment identity renders", () => {
  it("runs list: an environment-backed run exposes no name and no revision", () => {
    renderWithProviders(
      <SuiteRunsList
        runs={[
          envRun("envrun00", "env-a", "Staging", 4, {
            createdAt: 20_000,
            completedAt: 21_000,
          }),
        ]}
        allIterations={[]}
        onRunClick={vi.fn()}
      />
    );

    // The run still renders — only its environment identity is suppressed.
    expect(screen.getByText(/envrun00/i)).toBeInTheDocument();
    expectNoEnvironmentIdentity();
  });

  it("runs list: a legacy host run keeps today's host label", () => {
    renderWithProviders(
      <SuiteRunsList
        runs={[
          hostRun("hostrun0", "host-claude", {
            createdAt: 10_000,
            completedAt: 11_000,
          }),
        ]}
        allIterations={[]}
        hostNamesById={new Map([["host-claude", "Claude"]])}
        onRunClick={vi.fn()}
      />
    );

    expect(screen.getByText("Claude")).toBeInTheDocument();
  });

  it("results rail: a group of environment runs names none of them", () => {
    renderRail();
    expectNoEnvironmentIdentity();
  });

  it("case run history: an environment-backed batch names no environment", () => {
    const iterations = [
      {
        _id: "it-1",
        testCaseId: "case-1",
        suiteRunId: "envrun00",
        iterationNumber: 1,
        result: "passed",
        createdAt: 1_000,
        actualToolCalls: [],
        tokensUsed: 0,
      },
    ] as unknown as EvalIteration[];

    renderWithProviders(
      <CaseRunsHistory
        iterations={iterations}
        onSelectIteration={vi.fn()}
        suiteRuns={[envRun("envrun00", "env-a", "Staging", 4)]}
      />
    );

    expectNoEnvironmentIdentity();
  });
});

describe("kill switch off — the count and axis noun stay ungated", () => {
  it("runs list and results rail agree on '2 environments'", () => {
    const list = renderWithProviders(
      <SuiteRunsList
        runs={twoEnvironmentsOneGroup}
        allIterations={[]}
        onRunClick={vi.fn()}
      />
    );
    const listHeader = screen.getByText(/Run group g/i).closest("button");
    expect(listHeader!.textContent).toContain("2 environments");
    list.unmount();

    renderRail();
    // Identical wording on the rail: gating the noun on one surface but not
    // the other made the kill switch produce two answers for one dataset.
    expect(screen.getByText("2 environments")).toBeInTheDocument();
  });

  it("counts CONTEXTS, so one environment re-run three times stays '1 environment'", () => {
    const list = renderWithProviders(
      <SuiteRunsList
        runs={oneEnvironmentThreeRuns}
        allIterations={[]}
        onRunClick={vi.fn()}
      />
    );
    const listHeader = screen.getByText(/Run group g/i).closest("button");
    expect(listHeader!.textContent).toContain("1 environment");
    expect(listHeader!.textContent).not.toContain("3 environments");
    list.unmount();

    renderRail(oneEnvironmentThreeRuns);
    expect(screen.getByText("1 environment")).toBeInTheDocument();
    expect(screen.queryByText(/3 environments/)).not.toBeInTheDocument();
    // …and with the flag off the single context is still not NAMED.
    expectNoEnvironmentIdentity();
  });
});
