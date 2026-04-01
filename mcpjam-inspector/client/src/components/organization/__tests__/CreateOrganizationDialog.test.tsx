import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { toast } from "sonner";
import { CreateOrganizationDialog } from "../CreateOrganizationDialog";

const mockUseAuth = vi.fn();
const createOrganizationMock = vi.fn();

vi.mock("@workos-inc/authkit-react", () => ({
  useAuth: (...args: unknown[]) => mockUseAuth(...args),
}));

vi.mock("@/hooks/useOrganizations", () => ({
  useOrganizationMutations: () => ({
    createOrganization: createOrganizationMock,
  }),
}));

vi.mock("sonner", () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
    warning: vi.fn(),
  },
}));

describe("CreateOrganizationDialog", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUseAuth.mockReturnValue({
      user: {
        firstName: "Marcelo",
      },
    });
  });

  it("formats billing errors when organization creation fails", async () => {
    createOrganizationMock.mockRejectedValue(
      new Error(
        JSON.stringify({
          code: "billing_limit_reached",
          limit: "maxWorkspaces",
          allowedValue: 1,
        }),
      ),
    );

    render(<CreateOrganizationDialog open={true} onOpenChange={vi.fn()} />);

    fireEvent.click(screen.getByRole("button", { name: "Create" }));

    await waitFor(() => {
      expect(createOrganizationMock).toHaveBeenCalledWith({
        name: "Marcelo's Org",
      });
    });
    expect(toast.error).toHaveBeenCalledWith(
      "This organization has reached its workspace limit (1). Upgrade to create more workspaces.",
    );
  });
});
