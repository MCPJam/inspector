import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  ciOwnedSuite,
  openSettingsRow,
  renderSettingsSheet,
  baseSuite,
} from "./settings-sheet-harness";

/**
 * The settings sheet as a DRAFT (S1).
 *
 * The behaviour these pin is the difference between the sheet before and
 * after: nothing is written until the person says so, and when they do it is
 * one write carrying exactly what they changed.
 *
 * The failure modes worth a test are the ones a person would report as
 * "it saved something I didn't mean to":
 *
 *   - a control that still writes on change,
 *   - a save that sends fields the person never touched,
 *   - a conflict that silently discards their edits,
 *   - and a read-only suite that offers a save it cannot perform.
 */

const mocks = vi.hoisted(() => ({
  applySuiteSettings: vi.fn(async () => ({ revisionNumber: 4 })),
  updateTestSuite: vi.fn(async () => ({})),
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock("convex/react", () => ({
  useMutation: (name: string) =>
    name === "testSuites:applySuiteSettings"
      ? mocks.applySuiteSettings
      : mocks.updateTestSuite,
  useQuery: () => undefined,
  useConvexAuth: () => ({ isAuthenticated: true, isLoading: false }),
}));

// S3 — the settings sheet reads per-suite capabilities. `unavailable` is the
// pre-capabilities behaviour, which is what every assertion in this file was
// written against; a real read here would also need `useConvex` on the mock
// above, which this file deliberately does not provide.
vi.mock("@/hooks/use-suite-capabilities", async (importOriginal) => {
  const actual = await importOriginal<
    typeof import("@/hooks/use-suite-capabilities")
  >();
  return {
    ...actual,
    useSuiteCapabilities: () => ({
      state: "unavailable",
      capabilities: null,
    }),
  };
});

vi.mock("sonner", () => ({
  toast: {
    success: (...args: unknown[]) => mocks.toastSuccess(...args),
    error: (...args: unknown[]) => mocks.toastError(...args),
  },
}));

vi.mock("@workos-inc/authkit-react", () => ({
  useAuth: () => ({ user: null, isLoading: false, signIn: vi.fn() }),
}));
vi.mock("@/hooks/useGithubChecksSettings", () => ({
  useGithubChecksAvailability: () => ({ state: "disabled" }),
  useGithubChecksSettings: () => ({
    availability: { state: "disabled" },
    repos: [],
  }),
}));
vi.mock("../suite-github-checks-section", () => ({
  SuiteGithubChecksSection: () => <div data-testid="github-checks-section" />,
}));
vi.mock("@/lib/error-reporting", () => ({ reportBoundaryError: vi.fn() }));
vi.mock("@/hooks/useProjectComputer", () => ({
  useEphemeralCloudAvailable: () => true,
}));
vi.mock("@/hooks/useComputersEnabled", () => ({
  useComputersEnabled: () => true,
}));
vi.mock("@/hooks/useProjectEnvironmentsEnabled", () => ({
  useProjectEnvironmentsEnabled: () => true,
}));
vi.mock("posthog-js/react", () => ({ useFeatureFlagEnabled: () => true }));
vi.mock("@/hooks/useProjectEnvironments", () => ({
  useProjectEnvironments: () => [],
}));
vi.mock("../use-suite-data", () => ({
  useSuiteData: () => ({ runTrendData: [], modelStats: [] }),
  useRunDetailData: () => ({ caseGroupsForSelectedRun: [] }),
}));
vi.mock("../eval-export-modal", () => ({ EvalExportModal: () => null }));
vi.mock("@/state/app-state-context", () => ({
  useSharedAppState: () => ({ servers: {} }),
}));
vi.mock("@mcpjam/design-system/popover", () => ({
  Popover: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  PopoverContent: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  PopoverTrigger: ({ children }: { children: React.ReactNode }) => (
    <>{children}</>
  ),
}));

beforeEach(() => {
  vi.clearAllMocks();
  Object.defineProperty(HTMLElement.prototype, "hasPointerCapture", {
    configurable: true,
    value: vi.fn(() => false),
  });
  Object.defineProperty(HTMLElement.prototype, "setPointerCapture", {
    configurable: true,
    value: vi.fn(),
  });
  Object.defineProperty(HTMLElement.prototype, "releasePointerCapture", {
    configurable: true,
    value: vi.fn(),
  });
});

function editName(value: string) {
  if (!screen.queryByRole("textbox", { name: "Suite name" })) {
    const button = document.querySelector(
      '[data-setting-key="name"] button',
    ) as HTMLButtonElement | null;
    if (!button) throw new Error("no header name button");
    fireEvent.click(button);
  }
  fireEvent.change(screen.getByLabelText("Suite name"), { target: { value } });
}

function expectSuiteName(value: string) {
  const input = screen.queryByRole("textbox", { name: "Suite name" });
  if (input) {
    expect((input as HTMLInputElement).value).toBe(value);
    return;
  }
  expect(screen.getByRole("button", { name: value })).toBeTruthy();
}

function editMinIterations(value: string) {
  openSettingsRow(document.body, "policy");
  fireEvent.change(
    screen.getByLabelText("Minimum iterations per case for every run"),
    { target: { value } },
  );
}

describe("nothing is written until the person says so", () => {
  it("editing a control writes nothing and shows no toast", () => {
    renderSettingsSheet();
    editName("Renamed");

    // The whole point of the change. Before this, every one of these controls
    // fired a mutation and a toast on change.
    expect(mocks.applySuiteSettings).not.toHaveBeenCalled();
    expect(mocks.updateTestSuite).not.toHaveBeenCalled();
    expect(mocks.toastSuccess).not.toHaveBeenCalled();
  });

  it("the commit bar appears with a count and disappears on discard", () => {
    renderSettingsSheet();
    expect(screen.queryByTestId("suite-settings-commit-bar")).toBeNull();

    editName("Renamed");
    const bar = screen.getByTestId("suite-settings-commit-bar");
    expect(bar.textContent).toContain("1 unsaved change");

    fireEvent.click(screen.getByRole("button", { name: "Discard" }));
    expect(screen.queryByTestId("suite-settings-commit-bar")).toBeNull();
  });

  it("counts each changed setting once, however many keystrokes it took", () => {
    renderSettingsSheet();
    editName("R");
    editName("Re");
    editName("Renamed");
    editMinIterations("5");

    // Two settings, four interactions. The old sheet would have written four
    // times and toasted four times.
    expect(
      screen.getByTestId("suite-settings-commit-bar").textContent,
    ).toContain("2 unsaved changes");
  });
});

describe("adding a check does not break the sheet", () => {
  it("Add check appends a check and the sheet keeps rendering", async () => {
    const user = userEvent.setup();
    const { container } = renderSettingsSheet();
    openSettingsRow(container, "checks");

    // The regression this covers: the menu passes an UPDATER, and a setter
    // that stored it verbatim put a function where a list belongs. Everything
    // that iterates `defaultPredicates` then threw, taking the sheet down.
    await user.click(screen.getByRole("button", { name: "Add scorer" }));
    await user.click(await screen.findByTestId("add-scorer-noToolErrors"));

    // Still standing, and the edit registered as one drafted change.
    expect(screen.getByTestId("suite-settings-commit-bar")).toBeTruthy();
    openSettingsRow(container, "name");
    expect(screen.getByLabelText("Suite name")).toBeTruthy();
  });
});

describe("saving sends exactly what changed", () => {
  it("one mutation carrying only the edited keys", async () => {
    renderSettingsSheet();
    editName("Renamed");
    editMinIterations("5");

    fireEvent.click(screen.getByRole("button", { name: "Review and save" }));
    fireEvent.click(screen.getByRole("button", { name: "Save settings" }));

    await waitFor(() =>
      expect(mocks.applySuiteSettings).toHaveBeenCalledTimes(1),
    );
    const args = mocks.applySuiteSettings.mock.calls[0][0] as Record<
      string,
      unknown
    >;
    // A save that resent every field would clobber a colleague's edit to a
    // row this person never opened.
    expect(Object.keys(args).sort()).toEqual([
      "minIterations",
      "name",
      "revision",
      "suiteId",
    ]);
    expect(args.name).toBe("Renamed");
    expect(args.revision).toMatchObject({ source: "ui" });
  });

  it("one toast, naming the revision the save produced", async () => {
    renderSettingsSheet();
    editName("Renamed");
    fireEvent.click(screen.getByRole("button", { name: "Review and save" }));
    fireEvent.click(screen.getByRole("button", { name: "Save settings" }));

    await waitFor(() => expect(mocks.toastSuccess).toHaveBeenCalledTimes(1));
    expect(mocks.toastSuccess.mock.calls[0][0]).toContain("r4");
  });

  it("the review lists what will change, before and after", () => {
    renderSettingsSheet();
    editName("Renamed");
    fireEvent.click(screen.getByRole("button", { name: "Review and save" }));

    const list = screen.getByTestId("review-change-list");
    expect(list.textContent).toContain("Test Suite");
    expect(list.textContent).toContain("Renamed");
  });

  it("a note travels with the save", async () => {
    renderSettingsSheet();
    editName("Renamed");
    fireEvent.click(screen.getByRole("button", { name: "Review and save" }));
    fireEvent.change(screen.getByLabelText("Why you are making this change"), {
      target: { value: "Tightening the gate before launch" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save settings" }));

    await waitFor(() => expect(mocks.applySuiteSettings).toHaveBeenCalled());
    const args = mocks.applySuiteSettings.mock.calls[0][0] as {
      revision: { note?: string };
    };
    // The next person reading the history gets a reason rather than a diff
    // they have to interpret.
    expect(args.revision.note).toBe("Tightening the gate before launch");
  });
});

describe("a note belongs to one change", () => {
  it("does not carry the previous save's reason into the next one", async () => {
    renderSettingsSheet();
    editName("First");
    fireEvent.click(screen.getByRole("button", { name: "Review and save" }));
    fireEvent.change(screen.getByLabelText("Why you are making this change"), {
      target: { value: "First reason" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save settings" }));
    await waitFor(() => expect(mocks.applySuiteSettings).toHaveBeenCalled());

    // Second change, no note typed. The dialog is mounted unconditionally by
    // the sheet, so without a reset the first reason would be filed against
    // this revision — the opposite of what the note is for.
    editName("Second");
    fireEvent.click(screen.getByRole("button", { name: "Review and save" }));
    expect(
      (
        screen.getByLabelText(
          "Why you are making this change",
        ) as HTMLTextAreaElement
      ).value,
    ).toBe("");
  });

  it("a trimmed name is what the sheet shows after saving", async () => {
    renderSettingsSheet();
    editName("  Renamed  ");
    fireEvent.click(screen.getByRole("button", { name: "Review and save" }));
    fireEvent.click(screen.getByRole("button", { name: "Save settings" }));

    await waitFor(() => expect(mocks.applySuiteSettings).toHaveBeenCalled());
    expect(
      (mocks.applySuiteSettings.mock.calls[0][0] as { name: string }).name,
    ).toBe("Renamed");
    // And the header agrees, rather than holding whitespace the server dropped.
    await waitFor(() => expectSuiteName("Renamed"));
  });

  it("announces the count on the text, not on the whole bar", () => {
    renderSettingsSheet();
    editName("Renamed");

    // A live region wrapping Discard and Review and save would re-announce
    // both buttons every time the count moved.
    const bar = screen.getByTestId("suite-settings-commit-bar");
    expect(bar.getAttribute("role")).toBeNull();
    const status = screen.getByRole("status");
    expect(status.textContent).toContain("1 unsaved change");
    expect(status.querySelector("button")).toBeNull();
  });

  it("a saved draft stops reporting unsaved changes immediately", async () => {
    renderSettingsSheet();
    editName("Renamed");
    fireEvent.click(screen.getByRole("button", { name: "Review and save" }));
    fireEvent.click(screen.getByRole("button", { name: "Save settings" }));

    // The Convex subscription has not delivered the new document yet.
    // Rebasing onto the stale one flashed the old values back and re-armed
    // the unsaved-changes guard for edits that were already written.
    await waitFor(() =>
      expect(screen.queryByTestId("suite-settings-commit-bar")).toBeNull(),
    );
    expectSuiteName("Renamed");
  });
});

describe("degrading and refusing", () => {
  it("falls back to the old mutation when the composite is not deployed", async () => {
    mocks.applySuiteSettings.mockRejectedValueOnce(
      new Error(
        "Could not find public function for 'testSuites:applySuiteSettings'",
      ),
    );
    renderSettingsSheet();
    editName("Renamed");
    fireEvent.click(screen.getByRole("button", { name: "Review and save" }));
    fireEvent.click(screen.getByRole("button", { name: "Save settings" }));

    // The inspector deploys ahead of the backend. The sheet still works there,
    // just without history.
    await waitFor(() => expect(mocks.updateTestSuite).toHaveBeenCalledTimes(1));
    expect(mocks.toastSuccess).toHaveBeenCalledWith("Settings saved");
  });

  it("a concurrent save keeps the draft rather than discarding it", async () => {
    const conflict = Object.assign(new Error("conflict"), {
      data: { code: "EVAL_SUITE_REVISION_CONFLICT", current: 7 },
    });
    mocks.applySuiteSettings.mockRejectedValueOnce(conflict);
    renderSettingsSheet();
    editName("Renamed");
    fireEvent.click(screen.getByRole("button", { name: "Review and save" }));
    fireEvent.click(screen.getByRole("button", { name: "Save settings" }));

    await waitFor(() => expect(mocks.toastError).toHaveBeenCalled());
    // Throwing away someone's edits because a colleague saved first is the
    // outcome the precondition exists to PREVENT, not one to implement on its
    // refusal.
    expect(screen.getByTestId("suite-settings-commit-bar")).toBeTruthy();
    expectSuiteName("Renamed");
    expect(mocks.updateTestSuite).not.toHaveBeenCalled();
  });

  it("a read-only suite offers no bar to save from", () => {
    renderSettingsSheet({ readOnlyConfig: true } as never);
    expect(screen.queryByTestId("suite-settings-commit-bar")).toBeNull();
  });
});

/**
 * A CI-managed suite renders the sheet as a viewer.
 *
 * The lock's whole point is that a person can still SEE what the suite is
 * configured to do — the settings are the documentation — while the app stops
 * offering to change something the backend will refuse.
 */
describe("a suite managed by CI", () => {
  it("RENDERS THE SHEET — the settings are the documentation", () => {
    renderSettingsSheet({ suite: ciOwnedSuite, configLocked: true });

    // The regression this pins: an earlier revision folded the lock into
    // `isEditMode`, which gates the whole sheet, so a CI-owned suite navigated
    // to `suite-edit` and nothing appeared. The settings are exactly what a
    // person opens in order to understand what CI is running.
    expect(screen.getByTestId("suite-settings-locked")).toBeTruthy();
  });

  it("disables every control in it, not just the ones with a reason", () => {
    const { container } = renderSettingsSheet({
      suite: ciOwnedSuite,
      configLocked: true,
    });

    // A `fieldset[disabled]` is the mechanism, so a row added later is locked
    // without anybody remembering. The browser applies it to every nested form
    // control; a control in a portal (a dialog's body) escapes the subtree, but
    // its trigger does not, so the entry point is still blocked.
    //
    // Asserted on the fieldset rather than on each input: the DOM `disabled`
    // PROPERTY of a child reflects only its own attribute, so a per-input check
    // would read `false` here and say nothing about what a browser does.
    const locked = screen.getByTestId("suite-settings-locked");
    expect(locked.tagName).toBe("FIELDSET");
    expect((locked as HTMLFieldSetElement).disabled).toBe(true);
    expect(
      container.querySelectorAll(
        "fieldset[data-testid='suite-settings-locked'] input",
      ).length,
    ).toBeGreaterThan(0);
  });

  it("does not offer the name at all — it lives outside the fieldset", () => {
    renderSettingsSheet({ suite: ciOwnedSuite, configLocked: true });

    // The name is rendered by `SuiteHeader`, ABOVE the settings column's
    // `fieldset[disabled]`, so the fieldset cannot reach it and it needs its
    // own lock. Static text, not a button that opens an input: editing it fed
    // the settings draft and put the suite in the commit flow.
    expect(screen.queryByRole("textbox", { name: "Suite name" })).toBeNull();
    expect(
      document.querySelector('[data-setting-key="name"] button'),
    ).toBeNull();
  });

  it("cannot be committed even if a control is driven directly", () => {
    renderSettingsSheet({ suite: ciOwnedSuite, configLocked: true });

    // The second line of defence, and the one that does not depend on the
    // browser honouring `fieldset[disabled]`: jsdom does not enforce it, so
    // this change event reaches the field exactly as a synthetic one would.
    // There is still nothing to save.
    editMinIterations("7");
    expect(screen.queryByTestId("suite-settings-commit-bar")).toBeNull();
    expect(mocks.applySuiteSettings).not.toHaveBeenCalled();
    expect(mocks.updateTestSuite).not.toHaveBeenCalled();
  });

  it("says why, and offers the way out, at the top of the sheet", () => {
    const onDuplicateSuite = vi.fn();
    renderSettingsSheet({
      suite: ciOwnedSuite,
      configLocked: true,
      onDuplicateSuite,
    });

    // At the top, not on the control that refuses: someone opens Settings to
    // change something specific, and a reason reachable only by clicking the
    // thing that does not work is a reason most people never read.
    expect(screen.getByTestId("suite-settings-ci-owned")).toHaveTextContent(
      /Managed by CI/i,
    );
    fireEvent.click(screen.getByTestId("suite-settings-duplicate-to-edit"));
    expect(onDuplicateSuite).toHaveBeenCalledTimes(1);
  });

  it("has no commit bar, because there is nothing a commit could do", () => {
    renderSettingsSheet({ suite: ciOwnedSuite, configLocked: true });
    expect(screen.queryByTestId("suite-settings-commit-bar")).toBeNull();
    expect(mocks.applySuiteSettings).not.toHaveBeenCalled();
    expect(mocks.updateTestSuite).not.toHaveBeenCalled();
  });

  it("still commits for an app-authored suite", () => {
    // The guard against over-locking: the same sheet, unlocked, is unchanged.
    renderSettingsSheet();
    expect(screen.queryByTestId("suite-settings-ci-owned")).toBeNull();
    editName("Renamed");
    expect(screen.getByTestId("suite-settings-commit-bar")).toBeTruthy();
  });
});
