import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { OrganizationApiKeyPolicyCard } from "../OrganizationApiKeyPolicyCard";

const mockSetMintMinimumRole = vi.fn();

let hookState: {
  policy:
    | { mintMinimumRole: "member" | "admin"; updatedAt: number | null }
    | undefined;
  isLoading: boolean;
  error: string | null;
  isSaving: boolean;
};

vi.mock("@/hooks/useOrgApiKeyPolicy", () => ({
  useOrgApiKeyPolicy: () => ({
    ...hookState,
    setMintMinimumRole: mockSetMintMinimumRole,
  }),
}));

beforeEach(() => {
  mockSetMintMinimumRole.mockReset().mockResolvedValue(undefined);
  // An organization with no setting of its own (MJ-010).
  hookState = {
    policy: { mintMinimumRole: "admin", updatedAt: null },
    isLoading: false,
    error: null,
    isSaving: false,
  };
});

describe("OrganizationApiKeyPolicyCard", () => {
  it("shows key creation kept to owners and admins by default", () => {
    render(<OrganizationApiKeyPolicyCard organizationId="org-1" isAdmin />);

    expect(screen.getByTestId("org-api-key-policy-admins-only")).toBeChecked();
    expect(screen.getByText(/^On by default\./)).toBeInTheDocument();
  });

  it("lets an admin restrict key creation to owners and admins", async () => {
    hookState.policy = { mintMinimumRole: "member", updatedAt: 1 };
    render(<OrganizationApiKeyPolicyCard organizationId="org-1" isAdmin />);

    expect(
      screen.getByTestId("org-api-key-policy-admins-only"),
    ).not.toBeChecked();

    fireEvent.click(screen.getByTestId("org-api-key-policy-admins-only"));

    await waitFor(() =>
      expect(mockSetMintMinimumRole).toHaveBeenCalledWith("admin"),
    );
  });

  it("lets an admin open it back up to members", async () => {
    hookState.policy = { mintMinimumRole: "admin", updatedAt: 1 };
    render(<OrganizationApiKeyPolicyCard organizationId="org-1" isAdmin />);

    const toggle = screen.getByTestId("org-api-key-policy-admins-only");
    expect(toggle).toBeChecked();
    fireEvent.click(toggle);

    await waitFor(() =>
      expect(mockSetMintMinimumRole).toHaveBeenCalledWith("member"),
    );
  });

  it("is read-only for someone who is not an owner or admin", () => {
    render(
      <OrganizationApiKeyPolicyCard organizationId="org-1" isAdmin={false} />,
    );

    expect(screen.getByTestId("org-api-key-policy-admins-only")).toBeDisabled();
    expect(
      screen.getByText("Only organization owners and admins can change this."),
    ).toBeInTheDocument();
  });

  it("stays disabled until the current setting has loaded", () => {
    hookState = { ...hookState, policy: undefined, isLoading: true };
    render(<OrganizationApiKeyPolicyCard organizationId="org-1" isAdmin />);

    expect(screen.getByTestId("org-api-key-policy-admins-only")).toBeDisabled();
  });

  it("shows why the last save failed", () => {
    hookState = { ...hookState, error: "Insufficient permissions" };
    render(<OrganizationApiKeyPolicyCard organizationId="org-1" isAdmin />);

    expect(screen.getByTestId("org-api-key-policy-error")).toHaveTextContent(
      "Insufficient permissions",
    );
  });
});
