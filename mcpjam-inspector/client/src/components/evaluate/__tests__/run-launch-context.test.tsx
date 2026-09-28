import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";

import { RunLaunchContext, modelsFromRun } from "../run-launch-context";
import type { EvalIteration, EvalSuiteRun } from "../../evals/types";

vi.mock("@/hooks/useProjectEnvironmentsEnabled", () => ({
  useProjectEnvironmentsEnabled: () => false,
}));

function makeRun(
  overrides: Partial<EvalSuiteRun> & { _id: string },
): EvalSuiteRun {
  return {
    suiteId: "suite-1",
    createdBy: "u1",
    runNumber: 1,
    configRevision: "1",
    configSnapshot: {
      tests: [],
      environment: { servers: ["Excalidraw (App)"] },
    },
    status: "completed",
    result: "failed",
    createdAt: 1,
    completedAt: 2,
    source: "ui",
    namedHostId: "host-1",
    ...overrides,
  };
}

const hostNamesById = new Map<string, string | null>([["host-1", "Claude"]]);

describe("RunLaunchContext", () => {
  it("labels client, model from iterations, and server", () => {
    const iterations = [
      {
        testCaseSnapshot: { model: "anthropic/claude-haiku-4.5" },
      },
    ] as EvalIteration[];

    render(
      <RunLaunchContext
        run={makeRun({ _id: "run-1" })}
        hostNamesById={hostNamesById}
        iterations={iterations}
      />,
    );

    const strip = screen.getByTestId("evaluate-run-launch-context");
    expect(strip).toHaveTextContent("Client");
    expect(strip).toHaveTextContent("Claude");
    expect(strip).toHaveTextContent("Model");
    expect(strip).toHaveTextContent("claude-haiku-4.5");
    expect(strip).toHaveTextContent("Server");
    expect(screen.getByTestId("evaluate-run-servers")).toHaveTextContent(
      "Excalidraw (App)",
    );
  });

  it("prefers the run's effectiveModelId over iteration snapshots", () => {
    expect(
      modelsFromRun(
        makeRun({
          _id: "run-1",
          effectiveModelId: "anthropic/claude-sonnet-4-6",
        }),
        [
          {
            testCaseSnapshot: { model: "anthropic/claude-haiku-4.5" },
          } as EvalIteration,
        ],
      ),
    ).toEqual(["claude-sonnet-4-6"]);
  });
});
