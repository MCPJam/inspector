import { fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ProductUpdatesRow } from "../ProductUpdatesRow";

const mockUseConvexAuth = vi.fn();
const mockUseQuery = vi.fn();
const mockInitialize = vi.fn();
const mockDismissUpdate = vi.fn();

vi.mock("convex/react", () => ({
  useConvexAuth: (...args: unknown[]) => mockUseConvexAuth(...args),
  useQuery: (...args: unknown[]) => mockUseQuery(...args),
  useMutation: (name: string) => {
    if (name === "productUpdates:initializeIfNeeded") return mockInitialize;
    if (name === "productUpdates:dismissUpdate") return mockDismissUpdate;
    return vi.fn();
  },
}));

vi.mock("../productUpdates", () => ({
  PRODUCT_UPDATES: [
    {
      slug: "active",
      publishAt: Date.UTC(2026, 5, 4),
      title: "Active update",
      body: "Body",
    },
    {
      slug: "old",
      publishAt: Date.UTC(2026, 4, 4),
      title: "Old dismissed update",
      body: "Body",
    },
  ],
}));

vi.mock("../ProductUpdateHoverCard", () => ({
  ProductUpdateHoverCard: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  ),
}));

vi.mock("../ProductUpdateExpandedPanel", () => ({
  ProductUpdateExpandedPanel: () => null,
}));

describe("ProductUpdatesRow", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUseConvexAuth.mockReturnValue({ isAuthenticated: true });
    mockUseQuery.mockReturnValue({
      initializedAt: Date.UTC(2026, 4, 1),
      dismissedSlugs: ["old"],
    });
    mockInitialize.mockResolvedValue(undefined);
    mockDismissUpdate.mockResolvedValue(undefined);
  });

  it("combines the shipped update list with per-user backend state", () => {
    render(<ProductUpdatesRow />);

    expect(mockUseQuery).toHaveBeenCalledWith("productUpdates:getState", {});
    expect(
      screen.getByRole("heading", { name: "What's new" })
    ).toBeInTheDocument();
    expect(screen.getByText("1 update")).toBeInTheDocument();
    expect(screen.getByText("Active update")).toBeInTheDocument();
    expect(screen.queryByText("Old dismissed update")).not.toBeInTheDocument();
  });

  it("exposes dismissed shipped updates in history", () => {
    render(<ProductUpdatesRow />);

    fireEvent.click(screen.getByRole("button", { name: "View all" }));

    expect(screen.getByText("What's new · History")).toBeInTheDocument();
    expect(screen.getByText("Active update")).toBeInTheDocument();
    expect(screen.getByText("Old dismissed update")).toBeInTheDocument();
  });

  it("shows the caught-up state when the user dismissed every update", () => {
    mockUseQuery.mockReturnValue({
      initializedAt: Date.UTC(2026, 4, 1),
      dismissedSlugs: ["active", "old"],
    });

    render(<ProductUpdatesRow />);

    expect(screen.getByText("You're all caught up.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "View past updates" }));
    expect(screen.getByText("Active update")).toBeInTheDocument();
    expect(screen.getByText("Old dismissed update")).toBeInTheDocument();
  });
});
