import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { OrganizationSharingPolicyCard } from "../organization/OrganizationSharingPolicyCard";

const mockSetPolicy = vi.fn();

vi.mock("@/hooks/useOrgSharePolicy", () => ({
  useOrgSharePolicy: () => mockUseOrgSharePolicy(),
  useEffectiveSharePolicy: () => ({ policy: undefined, isLoading: false }),
}));

let hookState: {
  policy:
    | {
        maxShareMode: "project_members" | "invited_only" | "anyone_with_link";
        inviteAudience: "anyone" | "org_members";
        updatedAt: number | null;
      }
    | undefined;
  isLoading: boolean;
  error: string | null;
  isSaving: boolean;
};

function mockUseOrgSharePolicy() {
  return {
    ...hookState,
    setPolicy: mockSetPolicy,
  };
}

beforeEach(() => {
  mockSetPolicy.mockReset();
  mockSetPolicy.mockResolvedValue(undefined);
  hookState = {
    policy: {
      maxShareMode: "anyone_with_link",
      inviteAudience: "anyone",
      updatedAt: 1,
    },
    isLoading: false,
    error: null,
    isSaving: false,
  };
});

describe("OrganizationsTab sharing policy card", () => {
  it("renders the ceiling and audience controls", () => {
    render(
      <OrganizationSharingPolicyCard organizationId="org-1" isAdmin />,
    );
    expect(screen.getByTestId("org-sharing-policy-card")).toBeInTheDocument();
    expect(screen.getByText("Sharing")).toBeInTheDocument();
    expect(screen.getByTestId("org-share-max-mode")).toBeInTheDocument();
    expect(screen.getByTestId("org-share-invite-audience")).toBeInTheDocument();
  });

  it("lets an admin save a tighter audience", async () => {
    render(
      <OrganizationSharingPolicyCard organizationId="org-1" isAdmin />,
    );
    fireEvent.click(screen.getByTestId("org-share-invite-audience"));
    await waitFor(() => {
      expect(mockSetPolicy).toHaveBeenCalledWith({
        maxShareMode: "anyone_with_link",
        inviteAudience: "org_members",
      });
    });
  });

  it("disables controls for non-admins", () => {
    render(
      <OrganizationSharingPolicyCard
        organizationId="org-1"
        isAdmin={false}
      />,
    );
    expect(screen.getByTestId("org-share-max-mode")).toBeDisabled();
    expect(screen.getByTestId("org-share-invite-audience")).toBeDisabled();
    expect(
      screen.getByText("Only organization admins can change these."),
    ).toBeInTheDocument();
  });

  it("shows an error banner when the last write failed", () => {
    hookState = {
      ...hookState,
      error: "Your organization limits sharing to invited users only.",
    };
    render(
      <OrganizationSharingPolicyCard organizationId="org-1" isAdmin />,
    );
    expect(screen.getByTestId("org-sharing-policy-error")).toHaveTextContent(
      "Your organization limits sharing to invited users only.",
    );
  });
});
