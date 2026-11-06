import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryRouter, RouterProvider, useLocation } from "react-router";
import type { ReactNode } from "react";
import { parseEvalRouteFromUrl } from "@/lib/eval-route-url";
import type { EvalSuite } from "@/components/evals/types";
import type { SuiteSettingsSheet } from "@/components/evals/use-suite-settings-sheet";
import type { EvalBack, EvalCrumb } from "../../nav/eval-nav-crumbs";
import type { SuiteSettingsPageData } from "../use-suite-settings-page-data";

const suite: EvalSuite = {
  _id: "s1",
  createdBy: "u",
  name: "Excalidraw quickstart",
  description: "",
  configRevision: "r",
  environment: { servers: [] },
  createdAt: 1,
  updatedAt: 1,
  source: "ui",
  revisionNumber: 3,
};

const mocks = vi.hoisted(() => ({
  data: { status: "loading" } as SuiteSettingsPageData,
  locked: false,
  crumbBar: [] as Array<{
    crumbs: readonly EvalCrumb[];
    back?: EvalBack | null;
  }>,
  pageView: vi.fn(),
  apply: vi.fn(async () => ({ revisionNumber: 4 })),
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
  duplicateSuite: vi.fn(),
}));

vi.mock("../../nav/eval-nav-page-services", () => ({
  useEvalNavPageServices: () => ({ duplicateSuite: mocks.duplicateSuite }),
}));

vi.mock("../use-suite-settings-page-data", () => ({
  useSuiteSettingsPageData: () => mocks.data,
}));
vi.mock("../../evals-header", () => ({
  EvalCrumbBar: (props: {
    crumbs: readonly EvalCrumb[];
    back?: EvalBack | null;
    actions?: ReactNode;
  }) => {
    mocks.crumbBar.push(props);
    return <div data-testid="crumb-bar">{props.actions}</div>;
  },
}));
vi.mock("../../nav/eval-nav-analytics", () => ({
  useEvalNavPageView: (...args: unknown[]) => mocks.pageView(...args),
}));
vi.mock("@/components/billing/SharedSettingsGate", () => ({
  SharedSettingsGate: ({ children }: { children: ReactNode }) => (
    <>{children}</>
  ),
}));
vi.mock("@/components/evals/use-suite-config-lock", () => ({
  useSuiteConfigLock: () => ({
    capabilities: null,
    capabilitiesState: "ready",
    configLocked: mocks.locked,
    editingDisabled: mocks.locked,
  }),
}));
vi.mock("convex/react", () => ({
  useMutation: () => mocks.apply,
  useQuery: () => undefined,
}));
vi.mock("sonner", () => ({
  toast: {
    success: (...args: unknown[]) => mocks.toastSuccess(...args),
    error: (...args: unknown[]) => mocks.toastError(...args),
  },
}));
vi.mock("@/hooks/useScheduledEvalsEnabled", () => ({
  useScheduledEvalsEnabled: () => false,
}));
vi.mock("@/hooks/useSandboxImagesEnabled", () => ({
  useSandboxImagesEnabled: () => false,
}));
vi.mock("@/hooks/use-environment-capabilities", () => ({
  useEnvironmentCapabilities: () => null,
}));
vi.mock("@/components/evals/use-selected-run", () => ({
  useSelectedRun: () => ({ run: null }),
}));
vi.mock("@/components/evals/use-groundedness", () => ({
  useGroundedness: () => ({ result: null, pending: false }),
}));
// The tab bodies have their own tests; here they only need to edit the draft.
vi.mock("@/components/evals/suite-settings-fields", () => ({
  SuiteSettingsFields: ({ sheet }: { sheet: SuiteSettingsSheet }) => (
    <input
      aria-label="Model call retries"
      value={sheet.draft.current.turnRetries ?? ""}
      onChange={(event) =>
        sheet.dispatchDraft({
          type: "edit",
          key: "turnRetries",
          value: Number(event.target.value),
        })
      }
    />
  ),
}));
vi.mock("@/components/evals/suite-default-evaluators-section", () => ({
  SuiteDefaultEvaluatorsSection: ({ sheet }: { sheet: SuiteSettingsSheet }) => (
    <div data-setting-key="passOrFail">
      <button
        type="button"
        onClick={() =>
          sheet.dispatchDraft({
            type: "edit",
            key: "judgeRubric",
            value: { instructions: "   " },
          })
        }
      >
        Break the rubric
      </button>
    </div>
  ),
}));
vi.mock("../suite-cases-tab", async () => {
  const { useEvalNavigate } = await import("../../nav/eval-nav-state");
  return {
    SuiteCasesTab: () => {
      const navigate = useEvalNavigate();
      return (
        <button
          type="button"
          onClick={() =>
            navigate(
              { type: "case-settings", suiteId: "s1", testCaseId: "c1" },
              { via: "link" },
            )
          }
        >
          Open case
        </button>
      );
    },
  };
});

import { SuiteSettingsPage } from "../suite-settings-page";

const arrival = {
  evalNav: { via: "link", from: { path: "/evaluate/runs", place: "Runs" } },
};

function Host() {
  const location = useLocation();
  const route = parseEvalRouteFromUrl(
    "/evaluate",
    location.pathname,
    location.search,
  );
  if (route.type !== "suite-settings") {
    return <div data-testid="elsewhere">{route.type}</div>;
  }
  return <SuiteSettingsPage route={route} projectId="p1" />;
}

function renderPage(path = "/evaluate/suite/s1/settings") {
  const router = createMemoryRouter([{ path: "*", element: <Host /> }], {
    initialEntries: [{ pathname: path, state: arrival }],
  });
  render(<RouterProvider router={router} />);
  return router;
}

function ready(): SuiteSettingsPageData {
  return {
    status: "ready",
    suite,
    cases: [],
    runs: [],
    organizationId: "o1",
    availableModels: [],
    onAddProvider: null,
    canDeleteSuite: true,
  };
}

const lastBar = () => mocks.crumbBar[mocks.crumbBar.length - 1];

beforeEach(() => {
  // jsdom has no scrolling; the page scrolls to a setting after a Fix.
  Element.prototype.scrollTo = () => undefined;
  Element.prototype.scrollIntoView = () => undefined;
  mocks.data = ready();
  mocks.locked = false;
  mocks.crumbBar.length = 0;
  mocks.pageView.mockReset();
  mocks.apply.mockClear();
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("SuiteSettingsPage", () => {
  it("renders the heading, tabs and active body (H-1, V-1, V-3)", () => {
    renderPage();
    expect(screen.getByTestId("suite-settings-heading").textContent).toContain(
      "Excalidraw quickstart",
    );
    expect(
      screen
        .getByTestId("suite-settings-tab-settings")
        .getAttribute("aria-current"),
    ).toBe("page");
    expect(screen.getByTestId("suite-settings-tab-cases").textContent).toBe(
      "Test cases0",
    );
    expect(screen.getByLabelText("Model call retries")).toBeTruthy();
    expect(lastBar().crumbs.map((crumb) => crumb.label)).toEqual([
      "Evaluate",
      "Excalidraw quickstart",
      "Suite settings",
    ]);
    expect(lastBar().back).toEqual({
      label: "Back to Runs",
      path: "/evaluate/runs",
    });
    expect(screen.getByTestId("suite-settings-save")).toBeTruthy();
  });

  it("fires the nav page view with the route (A-1)", () => {
    renderPage("/evaluate/suite/s1/settings/evaluators");
    expect(mocks.pageView).toHaveBeenCalledWith(
      { type: "suite-settings", suiteId: "s1", tab: "evaluators" },
      { projectId: "p1", ui: "nav", enabled: true },
    );
  });

  it("switches tabs with replace, keeps location.state and drops importJob (I-1)", async () => {
    const router = renderPage("/evaluate/suite/s1/settings/cases");
    await act(() =>
      router.navigate("/evaluate/suite/s1/settings/cases?importJob=j1", {
        replace: true,
        state: arrival,
      }),
    );
    fireEvent.click(screen.getByTestId("suite-settings-tab-evaluators"));
    expect(router.state.historyAction).toBe("REPLACE");
    expect(router.state.location.pathname).toBe(
      "/evaluate/suite/s1/settings/evaluators",
    );
    expect(router.state.location.search).toBe("");
    expect(router.state.location.state).toEqual(arrival);
  });

  it("keeps a dirty draft across tabs without prompting (I-2, I-3)", () => {
    const confirm = vi.spyOn(window, "confirm");
    renderPage();
    fireEvent.change(screen.getByLabelText("Model call retries"), {
      target: { value: "4" },
    });
    expect(screen.getByText("Unsaved")).toBeTruthy();
    fireEvent.click(screen.getByTestId("suite-settings-tab-cases"));
    fireEvent.click(screen.getByTestId("suite-settings-tab-evaluators"));
    fireEvent.click(screen.getByTestId("suite-settings-tab-settings"));
    expect(confirm).not.toHaveBeenCalled();
    expect(
      (screen.getByLabelText("Model call retries") as HTMLInputElement).value,
    ).toBe("4");
  });

  it("prompts before leaving for a case with unsaved settings (I-3)", () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    const router = renderPage();
    fireEvent.change(screen.getByLabelText("Model call retries"), {
      target: { value: "4" },
    });
    fireEvent.click(screen.getByTestId("suite-settings-tab-cases"));
    fireEvent.click(screen.getByText("Open case"));
    expect(confirm).toHaveBeenCalledWith(
      "You have unsaved settings. Leave without saving?",
    );
    expect(router.state.location.pathname).toBe(
      "/evaluate/suite/s1/settings/cases",
    );
  });

  it("saves only the dirty settings, from any tab with ⌘S (S-1, S-3)", async () => {
    renderPage();
    fireEvent.change(screen.getByLabelText("Model call retries"), {
      target: { value: "4" },
    });
    fireEvent.click(screen.getByTestId("suite-settings-tab-cases"));
    await act(async () => {
      fireEvent.keyDown(window, { key: "s", metaKey: true });
    });
    expect(mocks.apply).toHaveBeenCalledTimes(1);
    const args = (mocks.apply.mock.calls[0] as unknown[])[0] as Record<
      string,
      unknown
    >;
    expect(args.suiteId).toBe("s1");
    expect(JSON.stringify(args)).toContain('"turnRetries":4');
    expect(args).not.toHaveProperty("name");
    expect(args).toHaveProperty("revision");
  });

  it("shows no save controls on a locked suite (S-2)", () => {
    mocks.locked = true;
    renderPage();
    expect(screen.queryByTestId("suite-settings-save")).toBeNull();
    expect(screen.queryByRole("button", { name: "Discard" })).toBeNull();
  });

  it("offers Duplicate to edit on a locked suite through page services", () => {
    mocks.locked = true;
    renderPage();
    fireEvent.click(screen.getByTestId("suite-settings-duplicate-to-edit"));
    expect(mocks.duplicateSuite).toHaveBeenCalledWith(suite);
  });

  it("Fix on a name error lands on Settings with the editor open (S-4)", () => {
    renderPage("/evaluate/suite/s1/settings/evaluators");
    fireEvent.click(screen.getByTestId("suite-settings-tab-settings"));
    fireEvent.click(
      screen.getByRole("button", { name: "Excalidraw quickstart" }),
    );
    fireEvent.change(screen.getByLabelText("Suite name"), {
      target: { value: "" },
    });
    fireEvent.click(screen.getByTestId("suite-settings-tab-evaluators"));
    expect(screen.getByText("Name is required")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Fix" }));
    expect(
      screen
        .getByTestId("suite-settings-tab-settings")
        .getAttribute("aria-current"),
    ).toBe("page");
    expect(document.activeElement).toBe(screen.getByLabelText("Suite name"));
  });

  it("Fix on a pass-or-fail error lands on Default evaluators (S-4)", () => {
    const router = renderPage("/evaluate/suite/s1/settings/evaluators");
    fireEvent.click(screen.getByText("Break the rubric"));
    fireEvent.click(screen.getByTestId("suite-settings-tab-settings"));
    fireEvent.click(screen.getByRole("button", { name: "Fix" }));
    expect(router.state.location.pathname).toBe(
      "/evaluate/suite/s1/settings/evaluators",
    );
  });

  it("shows a spinner while loading", () => {
    mocks.data = { status: "loading" };
    renderPage();
    expect(screen.getByTestId("suite-settings-loading")).toBeTruthy();
  });

  it("replaces to the list when the suite is missing (T-5)", () => {
    mocks.data = { status: "missing" };
    const router = renderPage();
    expect(router.state.historyAction).toBe("REPLACE");
    expect(screen.getByTestId("elsewhere").textContent).toBe("list");
  });
});
