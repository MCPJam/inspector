// @vitest-environment jsdom
import { useRef, useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import {
  createMemoryRouter,
  RouterProvider,
  useLocation,
  useNavigate,
} from "react-router";
import { useUnsavedChangesGuard } from "@/hooks/use-unsaved-changes-guard";
import { buildEvaluatePath } from "@/lib/app-navigation";
import { parseEvalRouteFromUrl } from "@/lib/eval-route-url";
import {
  SuiteSettingsTabStrip,
  useSuiteSettingsTabs,
} from "../suite-settings-tabs";

vi.mock("posthog-js/react", () => ({ useFeatureFlagEnabled: () => true }));

/** The tab wiring of the Suite settings page, under a real router. */
const scrolled = vi.fn();

function Harness({ committing = false }: { committing?: boolean }) {
  const location = useLocation();
  const navigate = useNavigate();
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(committing);
  // Read at scroll time, like the real scroll reads the DOM.
  const path = useRef(location.pathname);
  path.current = location.pathname;
  const route = parseEvalRouteFromUrl(
    "/evaluate",
    location.pathname,
    location.search,
  ) ?? { type: "list" as const };
  const tabs = useSuiteSettingsTabs({
    enabled: true,
    route,
    suiteId: "s1",
    toSuiteEdit: (suiteId, fromCaseChecks, tab, options) =>
      void navigate(
        buildEvaluatePath({
          type: "suite-edit",
          suiteId,
          ...(fromCaseChecks ? { fromCaseChecks } : {}),
          ...(tab === "evaluators" ? { tab } : {}),
        }),
        { replace: options?.replace },
      ),
    hasUnsavedChanges: dirty,
    isCommitting: saving,
    onDiscard: () => setDirty(false),
  });
  useUnsavedChangesGuard(
    dirty,
    () => setDirty(false),
    undefined,
    saving,
    tabs.isSamePage,
  );
  return (
    <div>
      <SuiteSettingsTabStrip tab={tabs.tab} onTabChange={tabs.requestTab} />
      {tabs.dialog}
      <button type="button" onClick={() => setDirty(true)}>
        Edit a setting
      </button>
      <button type="button" onClick={() => setDirty(false)}>
        Save
      </button>
      <button type="button" onClick={() => setSaving(!saving)}>
        Toggle saving
      </button>
      <button
        type="button"
        onClick={() =>
          tabs.goToSetting("passOrFail", (key) => scrolled(key, path.current), {
            fromFix: true,
          })
        }
      >
        Fix
      </button>
      <button
        type="button"
        onClick={() =>
          tabs.goToSetting("environments", (key) =>
            scrolled(key, path.current),
          )
        }
      >
        Go to Where it runs
      </button>
      <output data-testid="state">
        {location.pathname} dirty={String(dirty)}
      </output>
    </div>
  );
}

function renderAt(path: string, committing = false) {
  const element = <Harness committing={committing} />;
  const router = createMemoryRouter(
    [
      { path: "/evaluate/suite/:suiteId/settings", element },
      { path: "/evaluate/suite/:suiteId/settings/evaluators", element },
      // The suite page renders the same view, as in the app.
      { path: "/evaluate/suite/:suiteId", element },
      { path: "/elsewhere", element: <p>Elsewhere</p> },
    ],
    { initialEntries: ["/evaluate/suite/s1", path], initialIndex: 1 },
  );
  render(<RouterProvider router={router} />);
  return router;
}

const state = () => screen.getByTestId("state").textContent;
const tab = (name: string) => screen.getByRole("button", { name });

afterEach(() => {
  vi.restoreAllMocks();
  scrolled.mockReset();
});

describe("Suite settings tabs", () => {
  it("opens the tab named in the address", () => {
    renderAt("/evaluate/suite/s1/settings/evaluators");
    expect(tab("Default evaluators")).toHaveAttribute("aria-current", "page");
  });

  it("switches at once when nothing is unsaved", () => {
    renderAt("/evaluate/suite/s1/settings");
    fireEvent.click(tab("Default evaluators"));
    expect(state()).toBe("/evaluate/suite/s1/settings/evaluators dirty=false");
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });

  it("asks before dropping unsaved changes, and Keep editing stays", () => {
    const confirm = vi.spyOn(window, "confirm");
    renderAt("/evaluate/suite/s1/settings");
    fireEvent.click(screen.getByRole("button", { name: "Edit a setting" }));
    fireEvent.click(tab("Default evaluators"));

    const dialog = screen.getByRole("alertdialog");
    expect(dialog).toHaveTextContent("Discard unsaved changes?");
    expect(dialog).toHaveTextContent(
      "You have unsaved changes. Discard them to open Default evaluators, or keep editing and save first.",
    );
    fireEvent.click(screen.getByRole("button", { name: "Keep editing" }));

    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(state()).toBe("/evaluate/suite/s1/settings dirty=true");
    expect(confirm).not.toHaveBeenCalled();
  });

  it("Discard drops the changes and opens the other tab without the leave prompt", () => {
    const confirm = vi.spyOn(window, "confirm");
    renderAt("/evaluate/suite/s1/settings");
    fireEvent.click(screen.getByRole("button", { name: "Edit a setting" }));
    fireEvent.click(tab("Default evaluators"));
    fireEvent.click(screen.getByRole("button", { name: "Discard" }));

    expect(state()).toBe("/evaluate/suite/s1/settings/evaluators dirty=false");
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(confirm).not.toHaveBeenCalled();
  });

  it("switches once a save makes the draft clean while the dialog is open", () => {
    renderAt("/evaluate/suite/s1/settings");
    fireEvent.click(screen.getByRole("button", { name: "Edit a setting" }));
    fireEvent.click(tab("Default evaluators"));
    // ⌘S fires behind the dialog; the harness's Save stands in for it.
    fireEvent.click(screen.getByRole("button", { name: "Save", hidden: true }));

    expect(state()).toBe("/evaluate/suite/s1/settings/evaluators dirty=false");
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });

  it("ignores a tab click while a save is in flight", () => {
    renderAt("/evaluate/suite/s1/settings", true);
    fireEvent.click(screen.getByRole("button", { name: "Edit a setting" }));
    fireEvent.click(tab("Default evaluators"));

    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(state()).toBe("/evaluate/suite/s1/settings dirty=true");
  });

  it("Fix opens the other tab without the dialog and keeps the edits", () => {
    const confirm = vi.spyOn(window, "confirm");
    renderAt("/evaluate/suite/s1/settings");
    fireEvent.click(screen.getByRole("button", { name: "Edit a setting" }));
    fireEvent.click(screen.getByRole("button", { name: "Fix" }));

    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(state()).toBe("/evaluate/suite/s1/settings/evaluators dirty=true");
    expect(confirm).not.toHaveBeenCalled();
    // The scroll waits for the tab to render; scrolling to a hidden section does nothing.
    expect(scrolled).toHaveBeenCalledWith(
      "passOrFail",
      "/evaluate/suite/s1/settings/evaluators",
    );
  });

  it("Go to Where it runs asks first when there are unsaved changes", () => {
    renderAt("/evaluate/suite/s1/settings/evaluators");
    fireEvent.click(screen.getByRole("button", { name: "Edit a setting" }));
    fireEvent.click(screen.getByRole("button", { name: "Go to Where it runs" }));
    expect(screen.getByRole("alertdialog")).toBeInTheDocument();
    expect(scrolled).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Discard" }));
    expect(state()).toBe("/evaluate/suite/s1/settings dirty=false");
    expect(scrolled).toHaveBeenCalledWith(
      "environments",
      "/evaluate/suite/s1/settings",
    );
  });

  it("still shows the leave prompt for Back with unsaved changes", async () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    const router = renderAt("/evaluate/suite/s1/settings");
    fireEvent.click(screen.getByRole("button", { name: "Edit a setting" }));
    await act(async () => {
      await router.navigate(-1);
    });

    expect(confirm).toHaveBeenCalledTimes(1);
    expect(state()).toBe("/evaluate/suite/s1/settings dirty=true");
  });

  it("drops a pending switch when Back is confirmed with the dialog open", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    const router = renderAt("/evaluate/suite/s1/settings");
    fireEvent.click(screen.getByRole("button", { name: "Edit a setting" }));
    fireEvent.click(tab("Default evaluators"));
    expect(screen.getByRole("alertdialog")).toBeInTheDocument();

    await act(async () => {
      await router.navigate(-1);
    });

    expect(state()).toBe("/evaluate/suite/s1 dirty=false");
  });

  it("disables Discard while a save is in flight", () => {
    renderAt("/evaluate/suite/s1/settings");
    fireEvent.click(screen.getByRole("button", { name: "Edit a setting" }));
    fireEvent.click(tab("Default evaluators"));
    fireEvent.click(
      screen.getByRole("button", { name: "Toggle saving", hidden: true }),
    );
    expect(screen.getByRole("button", { name: "Discard" })).toBeDisabled();
  });

  it("does not arm a scroll it will not run while saving", async () => {
    const router = renderAt("/evaluate/suite/s1/settings/evaluators", true);
    fireEvent.click(screen.getByRole("button", { name: "Go to Where it runs" }));
    expect(screen.queryByRole("alertdialog")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Toggle saving" }));
    await act(async () => {
      await router.navigate("/evaluate/suite/s1/settings", { replace: true });
    });
    expect(scrolled).not.toHaveBeenCalled();
  });
});
