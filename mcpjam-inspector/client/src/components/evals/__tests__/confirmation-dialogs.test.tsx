import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { ConfirmationDialogs } from "../ConfirmationDialogs";
import type { EvalSuite } from "../types";

function makeSuite(overrides: Partial<EvalSuite> = {}): EvalSuite {
  return {
    _id: "suite-a",
    createdBy: "user-1",
    name: "Nightly",
    description: "",
    configRevision: "rev-1",
    environment: { servers: ["server-a"] },
    createdAt: 1,
    updatedAt: 1,
    source: "ui",
    tags: [],
    ...overrides,
  } as EvalSuite;
}

function renderDialogs(suiteToDelete: EvalSuite | null) {
  return render(
    <ConfirmationDialogs
      suiteToDelete={suiteToDelete}
      setSuiteToDelete={vi.fn()}
      deletingSuiteId={null}
      onConfirmDeleteSuite={vi.fn()}
      runToDelete={null}
      setRunToDelete={vi.fn()}
      deletingRunId={null}
      onConfirmDeleteRun={vi.fn()}
      testCaseToDelete={null}
      setTestCaseToDelete={vi.fn()}
      deletingTestCaseId={null}
      onConfirmDeleteTestCase={vi.fn()}
    />,
  );
}

describe("ConfirmationDialogs — deleting a CI-owned suite", () => {
  /*
   * Deleting a CI-owned suite is allowed, so the two things a person cannot
   * see before clicking have to be said HERE rather than in a refusal: the run
   * history goes with it, and the suite comes back on the next report because
   * `createEvalRunReporter()` identifies a suite by name (issue #5381).
   */
  it("says the history goes and the suite returns", () => {
    renderDialogs(makeSuite({ source: "sdk" }));

    expect(screen.getByText(/managed by CI/i)).toBeInTheDocument();
    expect(screen.getByText(/run history/i)).toBeInTheDocument();
    expect(screen.getByText(/creates the suite again/i)).toBeInTheDocument();
  });

  it("reads the same fact from a committed suite file", () => {
    renderDialogs(makeSuite({ declaredSuiteId: "s_from_file" }));

    expect(screen.getByText(/managed by CI/i)).toBeInTheDocument();
  });

  /*
   * NOT CI-owned, and the notice still has to appear. A UI-authored suite CI
   * reports INTO keeps its own cases — nothing recreates them — but its run
   * history is CI's, and the switcher stopped withholding delete for it, so
   * this dialog is the only place left that can say so.
   */
  it("warns about lost CI history on a suite CI merely reported into", () => {
    renderDialogs(makeSuite({ lastSdkRunAt: 123 }));

    expect(
      screen.getByText(/reported runs into this suite/i),
    ).toBeInTheDocument();
    expect(screen.queryByText(/managed by CI/i)).not.toBeInTheDocument();
  });

  it("says none of it for an app-authored suite", () => {
    renderDialogs(makeSuite());

    expect(screen.queryByText(/managed by CI/i)).not.toBeInTheDocument();
    expect(
      screen.getByText(/Are you sure you want to delete the test suite/i),
    ).toBeInTheDocument();
  });
});
