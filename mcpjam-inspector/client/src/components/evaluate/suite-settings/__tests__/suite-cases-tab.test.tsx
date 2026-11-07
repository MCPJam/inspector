import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryRouter, RouterProvider } from "react-router";
import type { EvalCase, EvalSuite } from "@/components/evals/types";

type GenerationState = {
  status?: string;
  authoringSource?: string;
  drafts: { id: string; authoring?: { source?: string } }[];
  reviewRequestId?: string;
  reviewSeenId?: string;
};

const mocks = vi.hoisted(() => ({
  generation: undefined as GenerationState | undefined,
  followAuthoringJob: vi.fn(async () => undefined),
  markImportReviewSeen: vi.fn(),
  reopenImportReview: vi.fn(),
  deleteTestCase: vi.fn(async () => undefined),
  isDirectGuest: false,
  connected: new Set<string>(),
  clearImportJob: vi.fn(),
}));

vi.mock("../../nav/eval-nav-page-services", () => ({
  useEvalNavPageServices: () => ({
    deleteTestCase: mocks.deleteTestCase,
    isDirectGuest: mocks.isDirectGuest,
    connectedServerNames: mocks.connected,
    ensureServersReady: undefined,
  }),
}));
vi.mock("@/lib/mcpjam-agent/eval-workspace", () => ({
  evalSuiteKey: () => "key",
  useEvalGeneration: (
    select: (state: { suites: Record<string, GenerationState> }) => unknown,
  ) => select({ suites: mocks.generation ? { key: mocks.generation } : {} }),
  followAuthoringJob: mocks.followAuthoringJob,
  markImportReviewSeen: mocks.markImportReviewSeen,
  reopenImportReview: mocks.reopenImportReview,
}));
vi.mock("../../eval-generated-drafts", () => ({
  EvalGeneratedDrafts: () => <div data-testid="drafts-review" />,
}));
vi.mock("../../eval-generation-workspace", () => ({
  EvalGenerationWorkspace: () => <div data-testid="generation-workspace" />,
}));
vi.mock("../../generate-cases-dialog", () => ({
  GenerateCasesDialog: ({
    onGenerate,
  }: {
    onGenerate: (c: object) => void;
  }) => (
    <button type="button" onClick={() => onGenerate({})}>
      Start generating
    </button>
  ),
}));
vi.mock("../../import-dataset-dialog", () => ({
  ImportDatasetDialog: () => null,
}));
vi.mock("convex/react", () => ({ useMutation: () => vi.fn() }));

import { SuiteCasesTab } from "../suite-cases-tab";

const suite: EvalSuite = {
  _id: "s1",
  createdBy: "u",
  name: "Excalidraw quickstart",
  description: "",
  configRevision: "r",
  environment: { servers: ["excalidraw"] },
  createdAt: 1,
  updatedAt: 1,
  source: "ui",
};
const other: EvalSuite = { ...suite, _id: "s2", name: "Asana SDK ingestion" };
const testCase = { _id: "c1", title: "Draw a rectangle" } as EvalCase;

function renderTab({
  cases = [testCase],
  importJob,
  locked = false,
}: { cases?: EvalCase[]; importJob?: string; locked?: boolean } = {}) {
  const route = {
    type: "suite-settings" as const,
    suiteId: "s1",
    tab: "cases" as const,
    ...(importJob ? { importJob } : {}),
  };
  const element = (
    <div>
      <nav data-testid="tabs" />
      <SuiteCasesTab
        route={route}
        names={{ suiteName: "Excalidraw quickstart" }}
        suite={suite}
        cases={cases}
        projectSuites={[suite, other]}
        projectId="p1"
        locked={locked}
        onClearImportJob={mocks.clearImportJob}
      />
    </div>
  );
  const router = createMemoryRouter([{ path: "*", element }], {
    initialEntries: ["/evaluate/suite/s1/settings/cases"],
  });
  render(<RouterProvider router={router} />);
  return router;
}

beforeEach(() => {
  mocks.generation = undefined;
  mocks.isDirectGuest = false;
  mocks.connected = new Set<string>();
  vi.clearAllMocks();
});
afterEach(() => cleanup());

describe("SuiteCasesTab", () => {
  it("opens a case with this page as its Back target (C-2)", () => {
    const router = renderTab();
    fireEvent.click(screen.getByTestId("suite-settings-case-row-c1"));
    expect(router.state.location.pathname).toBe(
      "/evaluate/suite/s1/settings/cases/c1",
    );
    expect(router.state.location.state).toEqual({
      evalNav: {
        via: "link",
        from: {
          path: "/evaluate/suite/s1/settings/cases",
          place: "suite settings",
        },
      },
    });
  });

  it("routes Describe to the new-case page and Add manually to today's editor (C-3)", async () => {
    const user = userEvent.setup();
    const router = renderTab();
    await user.click(screen.getByTestId("suite-settings-add-case"));
    await user.click(screen.getByTestId("suite-settings-add-case-describe"));
    expect(router.state.location.pathname).toBe(
      "/evaluate/suite/s1/settings/cases/new",
    );
    await act(() => router.navigate("/evaluate/suite/s1/settings/cases"));
    await user.click(screen.getByTestId("suite-settings-add-case"));
    await user.click(
      screen.getByTestId("suite-settings-add-case-add-manually"),
    );
    expect(router.state.location.pathname).toBe(
      "/evaluate/suite/s1/test/draft%3Aprompt/edit",
    );
  });

  it("deletes through page services only (C-9)", async () => {
    renderTab();
    fireEvent.click(screen.getByTestId("suite-settings-case-delete-c1"));
    await act(async () => {
      fireEvent.click(screen.getByTestId("suite-settings-case-delete-confirm"));
    });
    expect(mocks.deleteTestCase).toHaveBeenCalledTimes(1);
    expect(mocks.deleteTestCase).toHaveBeenCalledWith("c1");
  });

  it("shows the empty hero when there are no cases (C-8)", () => {
    renderTab({ cases: [] });
    expect(screen.getByTestId("suite-detail-empty-cases")).toBeTruthy();
    expect(screen.queryByTestId("suite-settings-test-cases")).toBeNull();
  });

  it("refuses Generate with no connected servers (C-4)", async () => {
    const user = userEvent.setup();
    renderTab();
    await user.click(screen.getByTestId("suite-settings-add-case"));
    expect(
      screen
        .getByTestId("suite-settings-add-case-generate")
        .hasAttribute("data-disabled"),
    ).toBe(true);
    expect(
      screen.getByText("Connect excalidraw to generate cases for this suite."),
    ).toBeTruthy();
  });

  it("generation replaces the card, not the tabs (C-5)", async () => {
    mocks.connected = new Set(["excalidraw"]);
    const user = userEvent.setup();
    renderTab();
    await user.click(screen.getByTestId("suite-settings-add-case"));
    await user.click(screen.getByTestId("suite-settings-add-case-generate"));
    await user.click(screen.getByText("Start generating"));
    expect(screen.getByTestId("generation-workspace")).toBeTruthy();
    expect(screen.queryByTestId("suite-settings-test-cases")).toBeNull();
    expect(screen.getByTestId("tabs")).toBeTruthy();
  });

  it("opens the import review on ?importJob= and clears it on leaving (C-6)", () => {
    mocks.generation = {
      status: "idle",
      drafts: [{ id: "d1", authoring: { source: "import" } }],
    };
    renderTab({ importJob: "j1" });
    expect(mocks.followAuthoringJob).toHaveBeenCalledWith(
      { projectId: "p1", suiteId: "s1" },
      "j1",
      { takeOver: true, source: "import" },
    );
    expect(screen.getByTestId("drafts-review")).toBeTruthy();
    expect(screen.queryByTestId("suite-settings-test-cases")).toBeNull();
    expect(screen.getByTestId("tabs")).toBeTruthy();
    fireEvent.click(screen.getByTestId("suite-import-review-close"));
    expect(mocks.markImportReviewSeen).toHaveBeenCalledWith({
      projectId: "p1",
      suiteId: "s1",
    });
    expect(mocks.clearImportJob).toHaveBeenCalledTimes(1);
  });

  it("offers Review N draft cases while drafts wait and the review is closed (C-7)", () => {
    mocks.generation = {
      status: "idle",
      drafts: [
        { id: "d1", authoring: { source: "import" } },
        { id: "d2", authoring: { source: "import" } },
      ],
      reviewRequestId: "r1",
      reviewSeenId: "r1",
    };
    renderTab();
    const button = screen.getByTestId("suite-resume-import-review");
    expect(button.textContent).toBe("Review 2 draft cases");
    fireEvent.click(button);
    expect(mocks.reopenImportReview).toHaveBeenCalledWith({
      projectId: "p1",
      suiteId: "s1",
    });
  });

  it("locked: no Add case, the CI reason, copy and delete stay (C-10)", () => {
    renderTab({ locked: true });
    expect(screen.queryByTestId("suite-settings-add-case")).toBeNull();
    expect(
      screen.getByText(
        "Managed by CI — edit the test file, or duplicate to edit here",
      ),
    ).toBeTruthy();
    expect(screen.getByTestId("suite-settings-case-copy-c1")).toBeTruthy();
    expect(screen.getByTestId("suite-settings-case-delete-c1")).toBeTruthy();
  });

  it("hides copy for a direct guest (P-8)", () => {
    mocks.isDirectGuest = true;
    renderTab();
    expect(screen.queryByTestId("suite-settings-case-copy-c1")).toBeNull();
  });
});
