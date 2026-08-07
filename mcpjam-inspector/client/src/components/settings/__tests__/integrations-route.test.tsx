import { render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { describe, expect, it, vi } from "vitest";

const {
  mockAvailability,
  mockRepos,
  mockNavigate,
  mockOrgsLoading,
  mockSlackConnections,
} = vi.hoisted(() => ({
  mockAvailability: {
    value: undefined as { state: "enabled" | "disabled" } | undefined,
    /** When set, the hook throws — what `useQuery` does on a query error. */
    error: null as Error | null,
  },
  mockRepos: { value: undefined as unknown[] | undefined },
  mockNavigate: vi.fn(),
  mockOrgsLoading: { value: false },
  mockSlackConnections: {
    value: undefined as
      | { workspaces: Array<{ installed: boolean }> }
      | undefined,
  },
}));

vi.mock("@/hooks/useGithubChecksSettings", () => ({
  useGithubChecksSettings: () => {
    if (mockAvailability.error) throw mockAvailability.error;
    return {
      availability: mockAvailability.value,
      repos: mockRepos.value,
    };
  },
}));

vi.mock("@/hooks/useOrgSlackSettings", () => ({
  useOrgSlackSettings: () => ({ connections: mockSlackConnections.value }),
}));

vi.mock("@/lib/app-navigation", () => ({
  useAppNavigate: () => mockNavigate,
  buildOrganizationPath: (id: string, section?: string) =>
    section ? `/organizations/${id}/${section}` : `/organizations/${id}`,
}));

vi.mock("convex/react", () => ({
  useConvexAuth: () => ({ isAuthenticated: true, isLoading: false }),
}));

vi.mock("@/hooks/useOrganizations", () => ({
  useOrganizationQueries: () => ({ isLoading: mockOrgsLoading.value }),
}));

vi.mock("../SettingsNav", () => ({
  SettingsNav: () => <nav data-testid="settings-nav" />,
}));

import { IntegrationsRoute } from "../IntegrationsRoute";

function renderRoute({
  availability,
  repos,
  error = null,
  activeOrganizationId = "org-1" as string | null,
  slackConnections,
}: {
  availability?: { state: "enabled" | "disabled" };
  repos?: unknown[];
  error?: Error | null;
  activeOrganizationId?: string | null;
  slackConnections?: { workspaces: Array<{ installed: boolean }> };
}) {
  mockAvailability.value = availability;
  mockAvailability.error = error;
  mockRepos.value = repos;
  mockSlackConnections.value = slackConnections;
  mockNavigate.mockClear();
  return render(
    <MemoryRouter initialEntries={["/settings/integrations"]}>
      <Routes>
        <Route
          path="/settings/integrations"
          element={
            <IntegrationsRoute activeOrganizationId={activeOrganizationId} />
          }
        />
        <Route path="/settings" element={<div>Settings Screen</div>} />
      </Routes>
    </MemoryRouter>
  );
}

describe("IntegrationsRoute", () => {
  it("always shows Slack, whatever GitHub's availability says", () => {
    // The reason the tab is unconditional: Slack is an integration every org
    // has, so the page must be useful without the GitHub beta.
    renderRoute({ availability: { state: "disabled" } });
    expect(screen.getByText("Slack")).toBeInTheDocument();
    expect(screen.queryByText("GitHub Checks")).not.toBeInTheDocument();
  });

  it("omits the GitHub card while availability is still unknown", () => {
    renderRoute({ availability: undefined });
    expect(screen.queryByText("GitHub Checks")).not.toBeInTheDocument();
  });

  it("shows the GitHub card when available", () => {
    renderRoute({ availability: { state: "enabled" }, repos: [] });
    expect(screen.getByText("GitHub Checks")).toBeInTheDocument();
  });

  it("reports how many repositories are connected", () => {
    renderRoute({
      availability: { state: "enabled" },
      repos: [{ _id: "a" }, { _id: "b" }],
    });
    expect(screen.getByText("2 repositories connected")).toBeInTheDocument();
  });

  it("says Not connected only once the list has actually loaded", () => {
    // `undefined` is "still asking". Rendering "Not connected" then would tell
    // a connected org their setup is gone.
    renderRoute({ availability: { state: "enabled" }, repos: undefined });
    expect(screen.queryByText("Not connected")).not.toBeInTheDocument();

    renderRoute({ availability: { state: "enabled" }, repos: [] });
    expect(screen.getByText("Not connected")).toBeInTheDocument();
  });

  it("singularizes a single repository", () => {
    renderRoute({ availability: { state: "enabled" }, repos: [{ _id: "a" }] });
    expect(screen.getByText("1 repository connected")).toBeInTheDocument();
  });

  it("navigates into the GitHub page", () => {
    renderRoute({ availability: { state: "enabled" }, repos: [] });
    screen.getByTestId("integration-card-github").click();
    expect(mockNavigate).toHaveBeenCalledWith("/settings/integrations/github");
  });

  it("sends Slack to the org's Slack connections tab", () => {
    renderRoute({ availability: { state: "enabled" }, repos: [] });
    screen.getByTestId("integration-card-slack").click();
    expect(mockNavigate).toHaveBeenCalledWith("/organizations/org-1/slack");
  });

  it("says Not connected only once the Slack connections have actually loaded", () => {
    // GitHub availability left `undefined` (card hidden) so its own "Not
    // connected" status can't be mistaken for the Slack card's.
    renderRoute({ slackConnections: undefined });
    expect(screen.queryByText("Not connected")).not.toBeInTheDocument();

    renderRoute({ slackConnections: { workspaces: [] } });
    expect(screen.getByText("Not connected")).toBeInTheDocument();
  });

  it("reports how many Slack workspaces are installed", () => {
    renderRoute({
      slackConnections: {
        workspaces: [{ installed: true }, { installed: false }],
      },
    });
    expect(screen.getByText("1 workspace connected")).toBeInTheDocument();
  });

  it("keeps Slack reachable when the GitHub query throws", () => {
    // `useQuery` re-throws on error (backend not deployed yet, or caller is not
    // a member of the active org). The GitHub card sits behind its own
    // boundary so that failure costs one card, not the page.
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    try {
      renderRoute({ error: new Error("Could not find function") });
      expect(screen.getByText("Slack")).toBeInTheDocument();
      expect(screen.queryByText("GitHub Checks")).not.toBeInTheDocument();
    } finally {
      consoleError.mockRestore();
    }
  });

  it("redirects to Settings when there is no active organization", () => {
    renderRoute({
      availability: { state: "enabled" },
      activeOrganizationId: null,
    });
    expect(screen.getByText("Settings Screen")).toBeInTheDocument();
  });
});
