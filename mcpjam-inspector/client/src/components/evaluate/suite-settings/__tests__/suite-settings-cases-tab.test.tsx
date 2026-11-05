import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { TooltipProvider } from "@mcpjam/design-system/tooltip";
import type { EvalCase, EvalSuite } from "../../../evals/types";
import { SuiteSettingsCasesTab } from "../suite-settings-cases-tab";

const testCase = { _id: "c_1", title: "Draw a rectangle" } as EvalCase;

vi.mock("../../case-authoring-takeovers", () => ({
  useCaseAuthoringTakeovers: () => ({
    takeover: null,
    generation: undefined,
    canGenerate: true,
    handleGenerateCases: vi.fn(),
    generateDialog: null,
  }),
}));
vi.mock("../copy-case-to-suite", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../copy-case-to-suite")>()),
  useCopyCaseToSuite: () => ({
    targets: [],
    copyCase: vi.fn(),
    copyingCaseId: null,
  }),
}));
vi.mock("../../import-dataset-dialog", () => ({
  ImportDatasetDialog: () => null,
}));
vi.mock("../../../evals/test-cases-overview", () => ({
  TestCasesOverview: ({
    renderRowActions,
    onDeleteTestCasesBatch,
  }: {
    renderRowActions?: (testCase: EvalCase) => ReactNode;
    onDeleteTestCasesBatch?: unknown;
  }) => (
    <div>
      {renderRowActions?.(testCase)}
      {onDeleteTestCasesBatch ? <button type="button">Delete</button> : null}
    </div>
  ),
}));

const ciOwnedSuite: EvalSuite = {
  _id: "s_1",
  createdBy: "u",
  name: "CI suite",
  description: "",
  configRevision: "r",
  environment: { servers: [] },
  createdAt: 1,
  updatedAt: 1,
  declaredSuiteId: "from_file",
};

describe("SuiteSettingsCasesTab", () => {
  it("offers Copy on a CI-owned suite's rows, and nothing that edits it", () => {
    render(
      <TooltipProvider>
        <SuiteSettingsCasesTab
          suite={ciOwnedSuite}
          cases={[testCase]}
          runs={[]}
          projectId="p_1"
          editingDisabled
          generateState={null}
          connectedServerNames={new Set()}
          onAddCase={vi.fn()}
          onOpenCase={vi.fn()}
          onOpenCopy={vi.fn()}
          onDeleteCases={vi.fn()}
        />
      </TooltipProvider>,
    );
    expect(
      screen.getByRole("button", { name: "Copy test case: Draw a rectangle" }),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Add case" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Delete" })).toBeNull();
  });
});
