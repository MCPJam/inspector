import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockAvailability,
  mockRepos,
  mockSuites,
  mockSetRepoEnabled,
  mockSetRepoSuite,
  mockDisconnectRepo,
  mockConnectRepo,
  mockListInstallationRepos,
  mockOrgsLoading,
  mockAuthLoading,
} = vi.hoisted(() => ({
  mockAvailability: {
    value: undefined as { state: "enabled" | "disabled" } | undefined,
  },
  mockRepos: { value: undefined as unknown[] | undefined },
  mockSuites: { value: [] as unknown[] },
  mockSetRepoEnabled: vi.fn(async () => ({ changed: true })),
  mockSetRepoSuite: vi.fn(async () => ({ changed: true })),
  mockDisconnectRepo: vi.fn(async () => ({ removed: true })),
  mockConnectRepo: vi.fn(async () => ({ configId: "cfg-new" })),
  mockListInstallationRepos: vi.fn(async () => [
    { fullName: "mcpjam/other-repo" },
  ]),
  mockOrgsLoading: { value: false },
  mockAuthLoading: { value: false },
}));

// The availability gate is the unit under test; the data layer is stubbed.
vi.mock("@/hooks/useGithubChecksSettings", () => ({
  GITHUB_CHECKS_UNAVAILABLE_MESSAGE:
    "GitHub Checks settings are not currently available.",
  useGithubChecksSettings: () => ({
    availability: mockAvailability.value,
    isEnabled: mockAvailability.value?.state === "enabled",
    repos: mockRepos.value,
    suites: mockSuites.value,
    connectRepo: mockConnectRepo,
    setRepoEnabled: mockSetRepoEnabled,
    setRepoSuite: mockSetRepoSuite,
    disconnectRepo: mockDisconnectRepo,
    listInstallationRepos: mockListInstallationRepos,
  }),
}));

vi.mock("@/lib/toast", () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}));

vi.mock("convex/react", () => ({
  useConvexAuth: () => ({
    isAuthenticated: !mockAuthLoading.value,
    isLoading: mockAuthLoading.value,
  }),
}));

vi.mock("@/hooks/useOrganizations", () => ({
  useOrganizationQueries: () => ({ isLoading: mockOrgsLoading.value }),
}));

// The nav resolves availability itself now; it is not what this file tests.
vi.mock("../SettingsNav", () => ({
  SettingsNav: () => <nav data-testid="settings-nav" />,
}));

import { GithubChecksRoute } from "../GithubChecksRoute";

const ROW = {
  _id: "cfg-1",
  repoFullName: "mcpjam/mcp-check-fixture",
  enabled: true,
  organizationId: "org-1",
  projectId: "proj-1",
  suiteId: "suite-1",
  createdAt: 1,
  updatedAt: 1,
};

function renderRoute(activeOrganizationId: string | null = "org-1") {
  return render(
    <MemoryRouter initialEntries={["/settings/github-checks"]}>
      <Routes>
        <Route
          path="/settings/github-checks"
          element={
            <GithubChecksRoute activeOrganizationId={activeOrganizationId} />
          }
        />
        <Route path="/settings" element={<div>Settings Screen</div>} />
      </Routes>
    </MemoryRouter>
  );
}

describe("GithubChecksRoute availability gate", () => {
  beforeEach(() => {
    mockAvailability.value = undefined;
    mockRepos.value = undefined;
    mockSuites.value = [
      { _id: "suite-1", name: "Fixture suite", projectId: "proj-1" },
      { _id: "suite-2", name: "Second suite", projectId: "proj-1" },
    ];
    mockOrgsLoading.value = false;
    mockAuthLoading.value = false;
    vi.clearAllMocks();
  });

  it("renders nothing while availability is still loading", () => {
    const { container } = renderRoute();
    // Crucially NOT a redirect: bouncing on "don't know" would strand a
    // legitimately-enabled user who cold-loads this URL.
    expect(container).toBeEmptyDOMElement();
    expect(screen.queryByText("Settings Screen")).not.toBeInTheDocument();
  });

  it("redirects to /settings when the backend says disabled", () => {
    mockAvailability.value = { state: "disabled" };
    renderRoute();
    expect(screen.getByText("Settings Screen")).toBeInTheDocument();
  });

  it("does not fetch installation repos while unavailable", () => {
    mockAvailability.value = { state: "disabled" };
    renderRoute();
    expect(mockListInstallationRepos).not.toHaveBeenCalled();
  });

  it("renders connected repositories when enabled", () => {
    mockAvailability.value = { state: "enabled" };
    mockRepos.value = [ROW];
    renderRoute();
    expect(screen.getByText("mcpjam/mcp-check-fixture")).toBeInTheDocument();
  });

  it("shows the install-App empty state when there are no repos", () => {
    mockAvailability.value = { state: "enabled" };
    mockRepos.value = [];
    renderRoute();
    expect(
      screen.getByText(/No repositories connected yet/)
    ).toBeInTheDocument();
    expect(screen.getByText("mcpjam.yaml")).toBeInTheDocument();
  });

  it("toggling a repository calls the mutation with the flipped value", () => {
    mockAvailability.value = { state: "enabled" };
    mockRepos.value = [ROW];
    renderRoute();

    fireEvent.click(
      screen.getByLabelText("Enable checks for mcpjam/mcp-check-fixture")
    );

    expect(mockSetRepoEnabled).toHaveBeenCalledWith({
      configId: "cfg-1",
      enabled: false,
    });
  });

  it("disconnecting a repository calls the mutation", () => {
    mockAvailability.value = { state: "enabled" };
    mockRepos.value = [ROW];
    renderRoute();

    fireEvent.click(
      screen.getByLabelText("Disconnect mcpjam/mcp-check-fixture")
    );

    expect(mockDisconnectRepo).toHaveBeenCalledWith({ configId: "cfg-1" });
  });

  it("redirects instead of hanging blank when there is genuinely no organization", () => {
    // The availability query is skipped without an org, so `undefined` here
    // never resolves — treating it as "loading" would blank the page forever.
    mockAvailability.value = undefined;
    mockOrgsLoading.value = false;
    renderRoute(null);
    expect(screen.getByText("Settings Screen")).toBeInTheDocument();
  });

  it("does NOT redirect during the organization bootstrap window", () => {
    // A deep link lands before `activeOrganizationId` resolves. Redirecting on
    // that first render would bounce a user who does have an org.
    mockAvailability.value = undefined;
    mockOrgsLoading.value = true;
    const { container } = renderRoute(null);
    expect(container).toBeEmptyDOMElement();
    expect(screen.queryByText("Settings Screen")).not.toBeInTheDocument();
  });

  it("does NOT redirect while Convex auth is still resolving", () => {
    // `useOrganizationQueries().isLoading` is `isAuthenticated && …`, so it
    // reads FALSE during auth bootstrap. Gating on it alone would bounce a
    // cold deep link before anyone knows who the user is.
    mockAvailability.value = undefined;
    mockAuthLoading.value = true;
    mockOrgsLoading.value = false;
    const { container } = renderRoute(null);
    expect(container).toBeEmptyDOMElement();
    expect(screen.queryByText("Settings Screen")).not.toBeInTheDocument();
  });

  it("ignores a second toggle while the first is still in flight", async () => {
    mockAvailability.value = { state: "enabled" };
    mockRepos.value = [ROW];
    let release: (() => void) | undefined;
    mockSetRepoEnabled.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () => resolve({ changed: true });
        })
    );
    renderRoute();

    const toggle = screen.getByLabelText(
      "Enable checks for mcpjam/mcp-check-fixture"
    );
    fireEvent.click(toggle);
    fireEvent.click(toggle);

    // Both clicks read the same pre-write snapshot, so an unguarded handler
    // would send `enabled: false` twice and lose the user's second intent.
    expect(mockSetRepoEnabled).toHaveBeenCalledTimes(1);
    release?.();
  });

  it("does not blame the user when the GitHub repo fetch fails", async () => {
    mockAvailability.value = { state: "enabled" };
    mockRepos.value = [];
    mockListInstallationRepos.mockRejectedValueOnce(new Error("network"));
    renderRoute();

    // "Install the App" would be a lie when the real problem is an outage.
    expect(
      await screen.findByText(/Could not load repositories from GitHub/)
    ).toBeInTheDocument();
    expect(
      screen.queryByText(/No repositories available/)
    ).not.toBeInTheDocument();
  });

  it("shows a loading row rather than an empty state before the list arrives", () => {
    mockAvailability.value = { state: "enabled" };
    mockRepos.value = undefined;
    renderRoute();
    // `undefined` is "not loaded", `[]` is "genuinely none" — conflating them
    // would flash an install-the-App CTA at someone who has repos.
    expect(screen.getByText("Loading…")).toBeInTheDocument();
    expect(
      screen.queryByText(/No repositories connected yet/)
    ).not.toBeInTheDocument();
  });
});
