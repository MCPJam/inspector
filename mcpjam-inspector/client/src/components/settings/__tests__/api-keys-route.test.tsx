import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiKeysRoute } from "../ApiKeysRoute";
const state = vi.hoisted(() => ({
  keys: [] as any[],
  error: null as string | null,
  truncated: false,
  revoke: vi.fn(),
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
    isCreating: false,
    isRevoking: false,
  }),
}));
const policyHook = vi.hoisted(() => ({ throws: null as Error | null }));
vi.mock("@/hooks/useOrgApiKeyPolicy", () => ({
  useOrgApiKeyPolicy: () => {
    if (policyHook.throws) throw policyHook.throws;
    return {
      policy: { mintMinimumRole: "member", updatedAt: null },
      isLoading: false,
      error: null,
      isSaving: false,
      setMintMinimumRole: vi.fn(),
    };
  },
}));
vi.mock("@/lib/error-reporting", () => ({ reportBoundaryError: vi.fn() }));
vi.mock("../SettingsPageShell", () => ({
  SettingsPageShell: ({ children }: any) => <main>{children}</main>,
}));
vi.mock("@/lib/toast", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

const DAY_MS = 24 * 60 * 60 * 1000;

beforeEach(() => {
  policyHook.throws = null;
  state.error = null;
  state.truncated = false;
  state.revoke = vi.fn().mockResolvedValue(undefined);
  state.keys = [
    {
      id: "key-a",
      name: "CI",
      organizationId: "org-a",
      obfuscated_value: "sk_…123",
      expires_at: new Date(Date.now() + 90 * DAY_MS).toISOString(),
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
    // The org's key creation setting belongs to the org page only.
    expect(
      screen.queryByTestId("org-api-key-policy-card"),
    ).not.toBeInTheDocument();
  });
  it("shows user attribution and a revoke control, but no create, in organization settings", () => {
    render(<ApiKeysRoute organizationId="org-a" isAdmin />);
    expect(screen.getByText("Alex · alex@example.com")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Revoke CI" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Create API key" }),
    ).not.toBeInTheDocument();
    expect(screen.getByTestId("org-api-key-policy-card")).toBeInTheDocument();
  });
  it("still lists keys against a backend that has not shipped the key creation setting", () => {
    policyHook.throws = new Error(
      "[CONVEX Q(orgApiKeyPolicy:getOrgApiKeyPolicy)] Could not find public function for 'orgApiKeyPolicy:getOrgApiKeyPolicy'",
    );
    vi.spyOn(console, "debug").mockImplementation(() => {});
    render(<ApiKeysRoute organizationId="org-a" isAdmin />);

    expect(
      screen.queryByTestId("org-api-key-policy-card"),
    ).not.toBeInTheDocument();
    expect(screen.getByText("Alex · alex@example.com")).toBeInTheDocument();
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

describe("organization key revoke", () => {
  it("names the owner and revokes the key once its name is typed", async () => {
    const user = userEvent.setup();
    render(<ApiKeysRoute organizationId="org-a" isAdmin />);

    await user.click(screen.getByRole("button", { name: "Revoke CI" }));
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveTextContent("It belongs to Alex");
    await user.type(screen.getByLabelText(/Type the key name/), "CI");
    await user.click(screen.getByRole("button", { name: "Revoke key" }));

    await waitFor(() => expect(state.revoke).toHaveBeenCalledWith("key-a"));
  });

  it("lists a key whose owner's account is gone, and can still revoke it by id", async () => {
    const user = userEvent.setup();
    state.keys = [
      {
        id: "api_key_orphaned",
        name: null,
        obfuscated_value: null,
        organizationId: "org-a",
        expires_at: null,
        owner: null,
      },
    ];
    render(<ApiKeysRoute organizationId="org-a" isAdmin />);

    expect(screen.getByText("Unnamed key")).toBeInTheDocument();
    expect(
      screen.getByText("Unknown user (account removed)"),
    ).toBeInTheDocument();
    expect(screen.getByText("api_key_orphaned")).toBeInTheDocument();

    await user.click(
      screen.getByRole("button", { name: "Revoke api_key_orphaned" }),
    );
    await user.type(
      screen.getByLabelText(/Type the key name/),
      "api_key_orphaned",
    );
    await user.click(screen.getByRole("button", { name: "Revoke key" }));

    await waitFor(() =>
      expect(state.revoke).toHaveBeenCalledWith("api_key_orphaned"),
    );
  });

  it("warns when the organization has more keys than the page lists", () => {
    state.truncated = true;
    render(<ApiKeysRoute organizationId="org-a" isAdmin />);

    expect(screen.getByTestId("api-keys-truncated")).toHaveTextContent(
      "more API keys than this page can list",
    );
  });

  it("does not warn about truncation for a complete list", () => {
    render(<ApiKeysRoute organizationId="org-a" isAdmin />);

    expect(screen.queryByTestId("api-keys-truncated")).not.toBeInTheDocument();
  });
});

describe("key expiry", () => {
  it("shows when each key stops working, and flags keys that never do", () => {
    state.keys = [
      {
        id: "key-expired",
        name: "Old CI",
        obfuscated_value: "sk_…old",
        organizationId: "org-a",
        expires_at: new Date(Date.now() - DAY_MS).toISOString(),
      },
      {
        id: "key-soon",
        name: "Laptop",
        obfuscated_value: "sk_…lap",
        organizationId: "org-a",
        expires_at: new Date(Date.now() + 3 * DAY_MS).toISOString(),
      },
      {
        id: "key-legacy",
        name: "Legacy",
        obfuscated_value: "sk_…leg",
        organizationId: "org-a",
        expires_at: null,
      },
    ];
    render(<ApiKeysRoute />);

    const states = screen
      .getAllByTestId("api-key-expiry")
      .map((el) => [el.getAttribute("data-expiry-state"), el.textContent]);
    expect(states[0][0]).toBe("expired");
    expect(states[0][1]).toMatch(/^Expired /);
    expect(states[1]).toEqual(["expiring", "Expires in 3 days"]);
    expect(states[2]).toEqual(["none", "No expiry"]);
  });
});
