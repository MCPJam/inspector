/**
 * Regression: the run-group delete (trash) button must stay inside the narrow
 * ("w-60", 240px) results rail instead of overflowing past its edge, where the
 * split container's `overflow-hidden` clipped it (PUR-28).
 *
 * The fix is `min-w-0` on the `RunGroupItem` row wrapper and its middle "select"
 * button, so the flex column yields before the fixed-width trash button does.
 * jsdom has no layout engine, so we can't measure the clip directly; instead we
 * pin the two things that would regress if `min-w-0` were removed — the guards
 * themselves — plus that the delete control stays rendered and activatable,
 * including when the group carries no host/environment context data.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderWithProviders, screen, userEvent, waitFor } from "@/test";
import { toast } from "sonner";
import { SuiteResultsSplit } from "../suite-results-split";
import { contextSuite, envRun, hostRun } from "./run-context-fixtures";
import type { EvalSuiteRun } from "../types";

vi.mock("@/hooks/useProjectEnvironmentsEnabled", () => ({
  useProjectEnvironmentsEnabled: () => true,
  useProjectEnvironmentsEnabledState: () => true,
  PROJECT_ENVIRONMENTS_FEATURE_FLAG: "project-environments-enabled",
}));

// Mirrors the repo convention for asserting toast feedback: mock sonner and
// assert the toast fn was called, rather than depending on a mounted Toaster.
vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

// A two-run group whose environment names are long enough that, without
// `min-w-0` letting the middle column shrink, the middle content would shove
// the trash button past the 240px rail edge.
const LONG_NAME =
  "Staging environment with an extremely long descriptive name that overflows";
const longLabelGroup: EvalSuiteRun[] = [
  envRun("twoenv01", "env-a", LONG_NAME, 2, {
    runGroupId: "g-two",
    createdAt: 20_000,
    completedAt: 21_000,
  }),
  envRun("twoenv02", "env-b", `${LONG_NAME} (variant)`, 7, {
    runGroupId: "g-two",
    createdAt: 20_100,
    completedAt: 21_100,
  }),
];

function renderRail(
  runs: EvalSuiteRun[],
  extra?: Partial<React.ComponentProps<typeof SuiteResultsSplit>>,
) {
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
      onDeleteRun={vi.fn(async () => {})}
      {...extra}
    />,
  );
}

describe("RunGroupItem delete button stays visible in the narrow rail (PUR-28)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("keeps the min-w-0 guards so a long label can't push the trash button out", () => {
    renderRail(longLabelGroup);

    const deleteButton = screen.getByRole("button", {
      name: "Delete run group",
    });

    // The flex row that holds chevron · middle · trash must allow shrinking.
    const row = deleteButton.parentElement as HTMLElement;
    expect(row).toHaveClass("flex");
    expect(row).toHaveClass("items-stretch");
    expect(row).toHaveClass("min-w-0");

    // The middle "select" column is the one that must yield first — without
    // min-w-0 it holds its content width and overflows the fixed-width trash.
    const middleButton = screen
      .getByText(/Run group g/i)
      .closest("button") as HTMLElement;
    expect(middleButton).toHaveClass("flex-1");
    expect(middleButton).toHaveClass("min-w-0");
  });

  it("delete control is activatable — opens the confirm dialog and deletes every run in the group", async () => {
    const onDeleteRun = vi.fn(async () => {});
    const user = userEvent.setup();
    renderRail(longLabelGroup, { onDeleteRun });

    await user.click(screen.getByRole("button", { name: "Delete run group" }));

    // Confirm dialog for the whole group (both runs).
    expect(
      screen.getByRole("heading", { name: /Delete run group/i }),
    ).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /^Delete$/ }));

    expect(onDeleteRun).toHaveBeenCalledTimes(2);
    const deletedIds = onDeleteRun.mock.calls.map((c) => c[0]);
    expect(deletedIds).toEqual(
      expect.arrayContaining(["twoenv01", "twoenv02"]),
    );
  });

  it("surfaces failure feedback when a deletion rejects", async () => {
    const onDeleteRun = vi.fn().mockRejectedValue(new Error("network down"));
    // confirmDeleteRuns logs the failure via console.error before toasting;
    // swallow it so the expected rejection doesn't clutter test output.
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const user = userEvent.setup();
    renderRail(longLabelGroup, { onDeleteRun });

    await user.click(screen.getByRole("button", { name: "Delete run group" }));
    await user.click(screen.getByRole("button", { name: /^Delete$/ }));

    // The delete was attempted, and the failure surfaced as error feedback
    // rather than a silent no-op.
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith("Failed to delete run"),
    );
    expect(onDeleteRun).toHaveBeenCalled();
    expect(toast.success).not.toHaveBeenCalled();

    consoleError.mockRestore();
  });

  it("renders the delete button for a group carrying no host/environment context data", () => {
    // null/empty context: host runs with an empty hostNamesById map — the
    // context summary falls back rather than naming anything, and the trash
    // control must still render.
    const hostlessGroup: EvalSuiteRun[] = [
      hostRun("hostrun1", undefined, {
        runGroupId: "g-host",
        createdAt: 30_000,
        completedAt: 31_000,
      }),
      hostRun("hostrun2", undefined, {
        runGroupId: "g-host",
        createdAt: 30_100,
        completedAt: 31_100,
      }),
    ];

    renderRail(hostlessGroup, { hostNamesById: new Map() });

    expect(
      screen.getByRole("button", { name: "Delete run group" }),
    ).toBeInTheDocument();
  });
});
