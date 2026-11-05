import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { EvalCase, EvalSuite } from "../../../evals/types";
import {
  SuiteTestCasesTab,
  type SuiteTestCasesTabProps,
} from "../suite-test-cases-tab";

const mocks = vi.hoisted(() => ({
  navigate: vi.fn(),
  exitTakeover: vi.fn(),
  openGenerate: vi.fn(),
  takeover: null as React.ReactNode,
}));

vi.mock("../../create-suite-navigation", () => ({
  navigatePlaygroundEvalsRoute: mocks.navigate,
}));
// The Generate and Import flows are their own module with their own tests;
// here only whether the tab hosts them matters.
vi.mock("../../suite-case-authoring", () => ({
  useSuiteCaseAuthoring: () => ({
    generation: undefined,
    importedDrafts: [],
    reviewingImport: false,
    canGenerate: true,
    openGenerate: mocks.openGenerate,
    takeover: mocks.takeover,
    exitTakeover: mocks.takeover ? mocks.exitTakeover : null,
    generateDialog: null,
  }),
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const suite = { _id: "suite-1", name: "Excalidraw quickstart" } as EvalSuite;
const cases = [
  { _id: "case-1", title: "Draw a rectangle" },
  { _id: "case-2", title: "Sketch a two-node flow" },
] as EvalCase[];

function renderTab(props: Partial<SuiteTestCasesTabProps> = {}) {
  return render(
    <SuiteTestCasesTab
      suite={suite}
      cases={cases}
      projectId="project-1"
      readOnlyConfig={false}
      configLocked={false}
      onDeleteTestCasesBatch={vi.fn().mockResolvedValue(undefined)}
      onImportCases={vi.fn()}
      canGenerate
      isGenerating={false}
      {...props}
    />,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.takeover = null;
});

describe("SuiteTestCasesTab", () => {
  it("opens a case at its settings address", () => {
    renderTab();
    fireEvent.click(screen.getByTestId("suite-settings-case-case-2"));
    expect(mocks.navigate).toHaveBeenCalledWith({
      type: "case-settings",
      suiteId: "suite-1",
      testCaseId: "case-2",
    });
  });

  it("adds a case at the new-case address, and offers Generate and Import", async () => {
    const onImportCases = vi.fn();
    renderTab({ onImportCases });
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /Add case/ }));
    await user.click(await screen.findByRole("menuitem", { name: "New case" }));
    expect(mocks.navigate).toHaveBeenCalledWith({
      type: "case-new",
      suiteId: "suite-1",
    });

    await user.click(screen.getByRole("button", { name: /Add case/ }));
    await user.click(await screen.findByRole("menuitem", { name: "Generate" }));
    expect(mocks.openGenerate).toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: /Add case/ }));
    await user.click(await screen.findByRole("menuitem", { name: "Import" }));
    expect(onImportCases).toHaveBeenCalled();
  });

  it("deletes a case after confirming", async () => {
    const onDeleteTestCasesBatch = vi.fn().mockResolvedValue(undefined);
    renderTab({ onDeleteTestCasesBatch });
    fireEvent.click(screen.getByTestId("suite-settings-case-delete-case-1"));
    fireEvent.click(screen.getByTestId("suite-settings-case-delete-confirm"));
    await waitFor(() =>
      expect(onDeleteTestCasesBatch).toHaveBeenCalledWith(["case-1"]),
    );
  });

  it("renders each row's extra actions before Delete", () => {
    renderTab({
      rowActions: (row) => <button type="button">Copy {row.title}</button>,
    });
    const copy = screen.getByRole("button", { name: "Copy Draw a rectangle" });
    const remove = screen.getByTestId("suite-settings-case-delete-case-1");
    expect(
      copy.compareDocumentPosition(remove) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("offers neither Add case nor Delete on a CI-owned suite", () => {
    renderTab({ configLocked: true });
    expect(screen.queryByRole("button", { name: /Add case/ })).toBeNull();
    expect(
      screen.queryByTestId("suite-settings-case-delete-case-1"),
    ).toBeNull();
    expect(screen.getByTestId("suite-settings-case-case-1")).toBeTruthy();
  });

  it("shows the empty state when the suite has no cases", () => {
    renderTab({ cases: [] });
    expect(screen.getByTestId("suite-detail-empty-cases")).toBeTruthy();
    fireEvent.click(screen.getByTestId("suite-empty-action-describe"));
    expect(mocks.navigate).toHaveBeenCalledWith({
      type: "case-new",
      suiteId: "suite-1",
    });
  });

  it("shows a Generate or Import review in place of the list, with a way back", () => {
    mocks.takeover = <div data-testid="generation-review" />;
    renderTab();
    expect(screen.getByTestId("generation-review")).toBeTruthy();
    expect(screen.queryByText("Draw a rectangle")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Back to test cases" }));
    expect(mocks.exitTakeover).toHaveBeenCalled();
  });
});
