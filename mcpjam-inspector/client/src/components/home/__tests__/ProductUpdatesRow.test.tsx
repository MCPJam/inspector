import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ProductUpdatesRow } from "../ProductUpdatesRow";
import type { ProductUpdateEntry } from "../productUpdateEntry";

const mockUseConvexAuth = vi.fn();
const mockUseQuery = vi.fn();
const mockInitialize = vi.fn();
const mockDismissUpdate = vi.fn();

vi.mock("convex/react", () => ({
  useConvexAuth: (...args: unknown[]) => mockUseConvexAuth(...args),
  useQuery: (...args: unknown[]) => mockUseQuery(...args),
  useMutation: (name: string) => {
    if (name === "productUpdates:initializeIfNeeded") {
      return mockInitialize;
    }
    if (name === "productUpdates:dismissUpdate") {
      return mockDismissUpdate;
    }
    return vi.fn();
  },
}));

vi.mock("../ProductUpdateHoverCard", () => ({
  ProductUpdateHoverCard: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  ),
}));

vi.mock("../ProductUpdateExpandedPanel", () => ({
  ProductUpdateExpandedPanel: () => null,
}));

function createUpdate(
  overrides: Partial<ProductUpdateEntry> = {},
): ProductUpdateEntry {
  return {
    _id: "update-1",
    slug: "test-update",
    publishAt: Date.UTC(2026, 5, 4),
    title: "Test stateless MCP servers",
    body: "Body",
    dismissed: false,
    isNew: true,
    ...overrides,
  };
}

describe("ProductUpdatesRow", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUseConvexAuth.mockReturnValue({ isAuthenticated: true });
    mockInitialize.mockResolvedValue(undefined);
    mockDismissUpdate.mockResolvedValue(undefined);
  });

  it("renders active updates with clear-all controls", () => {
    mockUseQuery.mockReturnValue([createUpdate()]);

    render(<ProductUpdatesRow />);

    expect(screen.getByRole("heading", { name: "What's new" })).toBeInTheDocument();
    expect(screen.getByText("1 update")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Clear all" })).toBeInTheDocument();
    expect(screen.getByText("Test stateless MCP servers")).toBeInTheDocument();
  });

  it("shows an empty state after all updates are dismissed", () => {
    mockUseQuery.mockReturnValue([
      createUpdate({ slug: "first", dismissed: true }),
      createUpdate({ slug: "second", dismissed: true }),
    ]);

    render(<ProductUpdatesRow />);

    expect(screen.getByRole("heading", { name: "What's new" })).toBeInTheDocument();
    expect(screen.getByText("You're all caught up.")).toBeInTheDocument();
    expect(
      screen.getByText("New product updates will show up here."),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Clear all" })).not.toBeInTheDocument();
  });

  it("renders nothing when there are no product updates", () => {
    mockUseQuery.mockReturnValue([]);

    const { container } = render(<ProductUpdatesRow />);

    expect(container).toBeEmptyDOMElement();
  });
});
