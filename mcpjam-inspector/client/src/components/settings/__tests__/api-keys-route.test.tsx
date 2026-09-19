import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiKeysRoute } from "../ApiKeysRoute";
const state = vi.hoisted(() => ({
  keys: [] as any[],
  error: null as string | null,
}));
vi.mock("convex/react", () => ({
  useConvexAuth: () => ({ isAuthenticated: true }),
}));
vi.mock("@workos-inc/authkit-react", () => ({
  useAuth: () => ({ user: { id: "user-1" }, isLoading: false }),
}));
vi.mock("@/lib/app-navigation", () => ({ useAppNavigate: () => vi.fn() }));
vi.mock("@/hooks/useOrganizations", () => ({
  useOrganizationQueries: () => ({
    sortedOrganizations: [{ _id: "org-a", name: "Acme" }],
    isLoading: false,
  }),
}));
vi.mock("@/hooks/useApiKeys", () => ({
  useApiKeys: () => ({
    ...state,
    loading: false,
    create: vi.fn(),
    revoke: vi.fn(),
  }),
}));
vi.mock("../SettingsPageShell", () => ({
  SettingsPageShell: ({ children }: any) => <main>{children}</main>,
}));
vi.mock("@/lib/toast", () => ({ toast: { error: vi.fn() } }));
beforeEach(() => {
  state.error = null;
  state.keys = [
    {
      id: "key-a",
      name: "CI",
      organizationId: "org-a",
      obfuscated_value: "sk_…123",
      owner: { id: "user-1", name: "Alex", email: "alex@example.com" },
    },
  ];
});
describe("API key scope views", () => {
  it("shows organization scope and owner controls in personal settings", () => {
    render(<ApiKeysRoute />);
    expect(screen.getByText("Acme")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Revoke CI" }),
    ).toBeInTheDocument();
  });
  it("shows user attribution without owner mutation controls in organization settings", () => {
    render(<ApiKeysRoute organizationId="org-a" />);
    expect(screen.getByText("Alex · alex@example.com")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Revoke CI" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Create API key" }),
    ).not.toBeInTheDocument();
  });
  it("does not present a failed fetch as an empty key list", () => {
    state.keys = [];
    state.error = "Only organization owners and admins can view API keys.";
    render(<ApiKeysRoute organizationId="org-a" />);
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Only organization owners",
    );
    expect(screen.queryByText(/No API keys yet/)).not.toBeInTheDocument();
  });
});
