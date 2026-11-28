import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CREDENTIAL_EXPORT_SETTING_HINT } from "@/shared/credential-export-setting";
import {
  CREDENTIAL_EXPORT_TOGGLE_LABEL,
  OrganizationSecuritySection,
} from "../OrganizationSecuritySection";

const mockSetExportPolicy = vi.fn();

let hookState: {
  exportPolicy: "allow" | "deny" | undefined;
  isLoading: boolean;
  error: string | null;
  isSaving: boolean;
};

vi.mock("@/hooks/useCredentialExportPolicy", () => ({
  useCredentialExportPolicy: () => ({
    ...hookState,
    setExportPolicy: mockSetExportPolicy,
  }),
}));

beforeEach(() => {
  mockSetExportPolicy.mockReset().mockResolvedValue(undefined);
  // An organization that never changed it.
  hookState = {
    exportPolicy: "allow",
    isLoading: false,
    error: null,
    isSaving: false,
  };
});

describe("OrganizationSecuritySection", () => {
  it("shows credential export on by default, with what that allows", () => {
    render(<OrganizationSecuritySection organizationId="org-1" isAdmin />);

    expect(screen.getByRole("heading", { name: "Security" })).toBeVisible();
    expect(screen.getByTestId("org-credential-export-toggle")).toBeChecked();
    expect(
      screen.getByTestId("org-credential-export-description"),
    ).toHaveTextContent(
      "Members' local apps, the CLI and sandboxes can receive saved OAuth tokens, API keys and secrets",
    );
    // Turning it off does not reach what members already have.
    expect(
      screen.getByText(/Turning this off stops new deliveries\./),
    ).toHaveTextContent(
      "Tokens already on members' computers keep working until they expire",
    );
  });

  it("asks before an admin turns it off, then saves deny", async () => {
    render(<OrganizationSecuritySection organizationId="org-1" isAdmin />);

    fireEvent.click(screen.getByTestId("org-credential-export-toggle"));
    expect(mockSetExportPolicy).not.toHaveBeenCalled();
    expect(
      screen.getByTestId("org-credential-export-confirm-off"),
    ).toHaveTextContent(
      "Tokens they already have keep working until they expire",
    );

    fireEvent.click(
      screen.getByTestId("org-credential-export-confirm-off-button"),
    );
    await waitFor(() =>
      expect(mockSetExportPolicy).toHaveBeenCalledWith("deny"),
    );
    await waitFor(() =>
      expect(
        screen.queryByTestId("org-credential-export-confirm-off"),
      ).not.toBeInTheDocument(),
    );
  });

  it("keeps it on when the admin backs out", () => {
    render(<OrganizationSecuritySection organizationId="org-1" isAdmin />);

    fireEvent.click(screen.getByTestId("org-credential-export-toggle"));
    fireEvent.click(screen.getByRole("button", { name: "Keep it on" }));

    expect(mockSetExportPolicy).not.toHaveBeenCalled();
    expect(
      screen.queryByTestId("org-credential-export-confirm-off"),
    ).not.toBeInTheDocument();
  });

  it("turns it back on without asking", async () => {
    hookState.exportPolicy = "deny";
    render(<OrganizationSecuritySection organizationId="org-1" isAdmin />);

    const toggle = screen.getByTestId("org-credential-export-toggle");
    expect(toggle).not.toBeChecked();
    expect(
      screen.getByTestId("org-credential-export-description"),
    ).toHaveTextContent(
      "Only MCPJam-hosted connections can use saved OAuth tokens, API keys and secrets.",
    );

    fireEvent.click(toggle);
    await waitFor(() =>
      expect(mockSetExportPolicy).toHaveBeenCalledWith("allow"),
    );
  });

  it("is read-only for a member", () => {
    hookState.exportPolicy = "deny";
    render(
      <OrganizationSecuritySection organizationId="org-1" isAdmin={false} />,
    );

    expect(screen.getByTestId("org-credential-export-toggle")).toBeDisabled();
    expect(
      screen.getByText("Only organization owners and admins can change this."),
    ).toBeVisible();
  });

  it("shows no switch until the policy is known", () => {
    hookState = { ...hookState, exportPolicy: undefined, isLoading: true };
    render(<OrganizationSecuritySection organizationId="org-1" isAdmin />);

    expect(
      screen.queryByTestId("org-credential-export-toggle"),
    ).not.toBeInTheDocument();
    expect(
      screen.getByTestId("org-credential-export-toggle-loading"),
    ).toBeVisible();
  });

  it("shows why a save failed", () => {
    hookState.error = "Insufficient organization permissions";
    render(<OrganizationSecuritySection organizationId="org-1" isAdmin />);

    expect(screen.getByTestId("org-credential-export-error")).toHaveTextContent(
      "Insufficient organization permissions",
    );
  });

  it("is the switch every export refusal points to", () => {
    expect(CREDENTIAL_EXPORT_SETTING_HINT).toContain(
      `turn on ${CREDENTIAL_EXPORT_TOGGLE_LABEL} in Organization settings under Security`,
    );
  });
});
