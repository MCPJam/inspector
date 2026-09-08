import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { BenchCategory, BenchTrack } from "@/lib/apis/bench-api";
import { BenchCategorySelector } from "../BenchCategorySelector";

/**
 * The preflight response's own shape. A category is `{ id, title,
 * description, confidence?, runnable }` and a track is
 * `{ id, definitionId, profileId, version, kind, categoryId?, definitionHash,
 * writesToTarget }` — there is no `label`, no `reason`, no `toolCount`, and no
 * per-track `runnable`, because preflight only lists tracks that already have
 * an active definition.
 */
const CATEGORIES: BenchCategory[] = [
  {
    id: "crm",
    title: "CRM",
    description: "Contact and deal tools.",
    runnable: true,
  },
  {
    id: "tracker",
    title: "Issue tracker",
    description: "Issues, sprints and boards.",
    runnable: true,
  },
  {
    id: "payments",
    title: "Payments",
    description: "Charges, refunds and payouts.",
    runnable: false,
  },
];

const TRACKS: BenchTrack[] = [
  {
    id: "connector-bench/crm/standard@2026-08-01",
    definitionId: "def_1",
    profileId: "connector-bench/crm/standard",
    version: "2026-08-01",
    kind: "category",
    categoryId: "crm",
    definitionHash: "hash_1",
    writesToTarget: false,
  },
];

function renderSelector(
  overrides: Partial<Parameters<typeof BenchCategorySelector>[0]> = {},
) {
  const props = {
    categories: CATEGORIES,
    tracks: TRACKS,
    selectedCategoryId: "crm",
    selectedTrackId: "connector-bench/crm/standard@2026-08-01",
    onSelectCategory: vi.fn(),
    onSelectTrack: vi.fn(),
    onContinue: vi.fn(),
    ...overrides,
  };
  render(<BenchCategorySelector {...props} />);
  return props;
}

describe("a failed classifier is not a gate", () => {
  it("offers every runnable category and says why it is asking", () => {
    renderSelector({ classification: { failureReason: "timed out" } });

    expect(screen.getByText("CRM")).toBeInTheDocument();
    expect(screen.getByText("Issue tracker")).toBeInTheDocument();
    expect(
      screen.getByText(/We couldn.t classify this connector \(timed out\)/),
    ).toBeInTheDocument();
  });

  it("says nothing about classification when there is a ranking", () => {
    renderSelector({
      classification: {
        ranked: [
          {
            categorySlug: "crm",
            confidence: 0.82,
            rationale: "Nine contact tools.",
          },
        ],
      },
    });
    expect(
      screen.queryByText(/We couldn.t classify this connector/),
    ).not.toBeInTheDocument();
  });
});

describe("the receipt is shown as a proposal, with its reasoning", () => {
  it("renders confidence and rationale beside the category", () => {
    renderSelector({
      classification: {
        ranked: [
          {
            categorySlug: "tracker",
            confidence: 0.42,
            rationale: "Four tools mention issues.",
          },
        ],
      },
    });

    const row = screen.getByText("Issue tracker").closest("button");
    expect(row).toHaveTextContent("42% confidence");
    expect(row).toHaveTextContent("Four tools mention issues.");
  });

  it("reorders by the ranking without removing anything from the list", () => {
    renderSelector({
      classification: {
        ranked: [{ categorySlug: "tracker", confidence: 0.9 }],
      },
    });

    const labels = screen
      .getByLabelText("Categories")
      .querySelectorAll("button");
    expect(labels[0]).toHaveTextContent("Issue tracker");
    // The un-ranked ones stay: a ranking reorders, it never filters.
    expect(screen.getByText("CRM")).toBeInTheDocument();
    expect(screen.getByText("Payments")).toBeInTheDocument();
  });
});

describe("unrunnable options stay visible with their reason", () => {
  it("shows why a category cannot be run and refuses to select it", async () => {
    const props = renderSelector();
    // The cause is ours to phrase: preflight reports `runnable: false` and
    // sends no reason string, so inventing a per-category one would be
    // presenting a message the backend never wrote.
    expect(
      screen.getByText("No exam has been published for this category yet."),
    ).toBeInTheDocument();

    await userEvent.click(screen.getByText("Payments"));
    expect(props.onSelectCategory).not.toHaveBeenCalled();
  });

  it("describes a category it CAN run instead of warning about it", () => {
    renderSelector();
    expect(screen.getByText("Contact and deal tools.")).toBeInTheDocument();
  });

  /**
   * There is no per-track runnable flag to filter on: preflight lists only
   * definitions that are active, so a track reaching this component is by
   * construction one that can be run. The invariant worth holding is that
   * every track handed in is offered — silently dropping one would strand a
   * published exam with no way to select it.
   */
  it("offers every track preflight returned", () => {
    renderSelector();
    const tracks = screen.getByLabelText("Tracks");
    for (const track of TRACKS) {
      expect(tracks).toHaveTextContent(track.id);
    }
  });
});

describe("continuing needs a runnable category and a track", () => {
  it("refuses when the selected category cannot be run", () => {
    renderSelector({ selectedCategoryId: "payments" });
    expect(
      screen.getByText("See what this costs").closest("button"),
    ).toBeDisabled();
  });

  it("refuses with no track chosen", () => {
    renderSelector({ selectedTrackId: null });
    expect(
      screen.getByText("See what this costs").closest("button"),
    ).toBeDisabled();
  });
});

describe("a remembered choice is explained as a personal one", () => {
  it("says the prefill changes nothing anyone else sees", () => {
    renderSelector({ preferences: { categorySlug: "crm" } });
    expect(
      screen.getByText(/does not change how anyone else sees this server/),
    ).toBeInTheDocument();
  });
});
