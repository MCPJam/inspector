/**
 * The settings-history panel.
 *
 * Every save has recorded a numbered revision since the draft-and-commit sheet
 * shipped, and none of it was readable. What these tests pin is the difference
 * between showing that data and showing it USEFULLY:
 *
 *   - `changedFields` are STORAGE keys. A reader who sees "defaultPredicates"
 *     has to know the schema to connect it back to the Checks row they edited.
 *   - a key with no label renders RAW rather than being dropped: an unnamed
 *     change is still a change, and hiding it makes a revision look emptier
 *     than it was.
 *   - `pinnedRunCount` is capped, and a capped count that renders as an exact
 *     number is a number that is wrong.
 */

import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const mocks = vi.hoisted(() => ({
  paginated: vi.fn(),
  loadMore: vi.fn(),
  useQuery: vi.fn(),
}));

vi.mock("convex/react", () => ({
  usePaginatedQuery: () => mocks.paginated(),
  useQuery: (name: unknown, args: unknown) => mocks.useQuery(name, args),
}));

import { SuiteRevisionHistory, fieldLabel } from "../suite-revision-history";

function row(overrides: Record<string, unknown> = {}) {
  return {
    _id: "rev_1",
    revisionNumber: 7,
    source: "ui",
    createdBy: "user-1",
    createdByName: "Ada",
    createdAt: Date.now() - 60_000,
    note: null,
    changedFields: ["defaultPredicates"],
    revisionGroupId: null,
    configRevisionHashAfter: "abc",
    pinnedRunCount: 3,
    pinnedRunCountCapped: false,
    ...overrides,
  };
}

function renderHistory(
  results: Array<Record<string, unknown>>,
  status: string = "Exhausted",
) {
  mocks.paginated.mockReturnValue({
    results,
    status,
    loadMore: mocks.loadMore,
  });
  return render(
    <SuiteRevisionHistory suiteId="suite-1" open onOpenChange={vi.fn()} />,
  );
}

describe("SuiteRevisionHistory", () => {
  it("labels a storage key the way the settings page names it", () => {
    renderHistory([row()]);
    expect(screen.getByText("Checks")).toBeTruthy();
    // The storage spelling never reaches a reader.
    expect(screen.queryByText("defaultPredicates")).toBeNull();
  });

  it("renders an unlabelled key raw rather than dropping it", () => {
    renderHistory([row({ changedFields: ["somethingNobodyNamedYet"] })]);
    // Hiding it would make the revision look emptier than it was, which is
    // worse than an unfamiliar word.
    expect(screen.getByText("somethingNobodyNamedYet")).toBeTruthy();
  });

  it("marks a capped pinned-run count", () => {
    renderHistory([row({ pinnedRunCount: 100, pinnedRunCountCapped: true })]);
    // The count stops at the cap, so an exact "100 runs" would be a number
    // that is wrong for every suite past it.
    expect(screen.getByText("100+ runs")).toBeTruthy();
  });

  it("names the source in the reader's words, and unknown ones raw", () => {
    const { unmount } = renderHistory([row({ source: "file_sync" })]);
    expect(screen.getByText("File sync")).toBeTruthy();
    unmount();
    renderHistory([row({ source: "a_future_source" })]);
    expect(screen.getByText("a_future_source")).toBeTruthy();
  });

  it("attributes an unclaimed write to System, not to nobody", () => {
    renderHistory([row({ createdByName: null })]);
    expect(screen.getByText("System")).toBeTruthy();
  });

  it("offers Load more only while there are more pages", () => {
    const { unmount } = renderHistory([row()], "Exhausted");
    expect(screen.queryByRole("button", { name: "Load more" })).toBeNull();
    unmount();
    renderHistory([row()], "CanLoadMore");
    expect(screen.getByRole("button", { name: "Load more" })).toBeTruthy();
  });

  it("fetches the snapshots only when a row is opened", async () => {
    const user = userEvent.setup();
    mocks.useQuery.mockReturnValue({
      beforeSnapshot: { minIterations: 1, name: "Same" },
      afterSnapshot: { minIterations: 3, name: "Same" },
    });
    renderHistory([row()]);
    // The list carries no snapshots: a page of 25 whole suite configurations
    // is a large payload for a list nobody reads that way.
    expect(mocks.useQuery).not.toHaveBeenCalled();

    await user.click(screen.getByText("r7"));
    expect(mocks.useQuery).toHaveBeenCalledWith("testSuites:getSuiteRevision", {
      revisionId: "rev_1",
    });
    // Only the key that MOVED. Listing a field whose value is identical on
    // both sides asks a reader to look for a difference that is not there.
    expect(screen.getByText("Minimum iterations")).toBeTruthy();
    expect(screen.queryByText("Name")).toBeNull();
  });

  it("says so when there is nothing yet", () => {
    renderHistory([]);
    expect(screen.getByText("No saved changes yet.")).toBeTruthy();
  });
});

describe("fieldLabel", () => {
  it("maps the storage keys the revision log actually records", () => {
    expect(fieldLabel("judgeRubric")).toBe("Judge criteria");
    expect(fieldLabel("verdictPolicyDefaults")).toBe("Policy defaults");
    expect(fieldLabel("environmentIds")).toBe("Environments");
    expect(fieldLabel("unknownKey")).toBe("unknownKey");
  });
});
