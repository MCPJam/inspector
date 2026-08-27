import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { BenchCategory, BenchTrack } from "@/lib/apis/bench-api";
import { BenchCategorySelector } from "../BenchCategorySelector";

const CATEGORIES: BenchCategory[] = [
  { id: "crm", label: "CRM", runnable: true, toolCount: 9 },
  { id: "tracker", label: "Issue tracker", runnable: true, toolCount: 4 },
  {
    id: "payments",
    label: "Payments",
    runnable: false,
    reason: "No pinned exam for this category yet.",
  },
];

const TRACKS: BenchTrack[] = [
  { id: "standard", label: "Standard", runnable: true, categoryIds: ["crm"] },
  { id: "deep", label: "Deep", runnable: false, categoryIds: ["crm"] },
];

function renderSelector(
  overrides: Partial<Parameters<typeof BenchCategorySelector>[0]> = {},
) {
  const props = {
    categories: CATEGORIES,
    tracks: TRACKS,
    selectedCategoryId: "crm",
    selectedTrackId: "standard",
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
        ranked: [{ categorySlug: "crm", confidence: 0.82, rationale: "Nine contact tools." }],
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
    expect(
      screen.getByText("No pinned exam for this category yet."),
    ).toBeInTheDocument();

    await userEvent.click(screen.getByText("Payments"));
    expect(props.onSelectCategory).not.toHaveBeenCalled();
  });

  it("offers only runnable tracks", () => {
    renderSelector();
    const tracks = screen.getByLabelText("Tracks");
    expect(tracks).toHaveTextContent("Standard");
    expect(tracks).not.toHaveTextContent("Deep");
  });
});

describe("continuing needs a runnable category and a track", () => {
  it("refuses when the selected category cannot be run", () => {
    renderSelector({ selectedCategoryId: "payments" });
    expect(screen.getByText("See what this costs").closest("button")).toBeDisabled();
  });

  it("refuses with no track chosen", () => {
    renderSelector({ selectedTrackId: null });
    expect(screen.getByText("See what this costs").closest("button")).toBeDisabled();
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
