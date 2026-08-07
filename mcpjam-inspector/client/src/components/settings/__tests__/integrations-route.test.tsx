import { render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { describe, expect, it, vi } from "vitest";

const {
  mockAvailability,
  mockRepos,
  mockNavigate,
  mockOrgsLoading,
  mockDiscord,
} = vi.hoisted(() => ({
  mockDiscord: {
    enabled: false,
    /** null models VITE_MCPJAM_DISCORD_CLIENT_ID being unset. */
    installUrl: "https://discord.com/oauth2/authorize?client_id=1" as
      | string
      | null,
  },
  mockAvailability: {
    value: undefined as { state: "enabled" | "disabled" } | undefined,
    /** When set, the hook throws — what `useQuery` does on a query error. */
    error: null as Error | null,
  },
  mockRepos: { value: undefined as unknown[] | undefined },
  mockNavigate: vi.fn(),
  mockOrgsLoading: { value: false },
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

vi.mock("@/lib/app-navigation", () => ({
  useAppNavigate: () => mockNavigate,
  buildOrganizationPath: (id: string) => `/organizations/${id}`,
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

vi.mock("@/hooks/useDiscordAgentEnabled", () => ({
  useDiscordAgentEnabled: () => mockDiscord.enabled,
}));

vi.mock("@/lib/config", () => ({
  discordInstallUrl: () => mockDiscord.installUrl,
}));

import { IntegrationsRoute } from "../IntegrationsRoute";

function renderRoute({
  availability,
  repos,
  error = null,
  activeOrganizationId = "org-1" as string | null,
}: {
  availability?: { state: "enabled" | "disabled" };
  repos?: unknown[];
  error?: Error | null;
  activeOrganizationId?: string | null;
  discordEnabled?: boolean;
  discordInstallUrl?: string | null;
}) {
  mockAvailability.value = availability;
  mockAvailability.error = error;
  mockRepos.value = repos;
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
    </MemoryRouter>,
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

  it("sends Slack to project settings, where it is actually configured", () => {
    renderRoute({ availability: { state: "enabled" }, repos: [] });
    screen.getByTestId("integration-card-slack").click();
    expect(mockNavigate).toHaveBeenCalledWith("/project-settings");
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

  describe("the Discord card", () => {
    it("is hidden while the agent flag is off", () => {
      // The agent is dark: the bot lives in one test guild and cannot answer
      // anyone else. Offering an install would invite a dead bot into a server.
      renderRoute({ availability: { state: "enabled" }, repos: [] });
      expect(screen.queryByText("Discord")).not.toBeInTheDocument();
    });

    it("is hidden when no client id is configured, even with the flag on", () => {
      mockDiscord.enabled = true;
      mockDiscord.installUrl = null;
      try {
        renderRoute({ availability: { state: "enabled" }, repos: [] });
        expect(screen.queryByText("Discord")).not.toBeInTheDocument();
      } finally {
        mockDiscord.enabled = false;
        mockDiscord.installUrl =
          "https://discord.com/oauth2/authorize?client_id=1";
      }
    });

    it("renders as a real link out to Discord, not an in-app navigation", () => {
      mockDiscord.enabled = true;
      try {
        renderRoute({ availability: { state: "enabled" }, repos: [] });
        const card = screen.getByTestId("integration-card-discord");
        expect(card.tagName).toBe("A");
        expect(card).toHaveAttribute(
          "href",
          "https://discord.com/oauth2/authorize?client_id=1",
        );
        expect(card).toHaveAttribute("target", "_blank");
        expect(card).toHaveAttribute("rel", "noreferrer");
        expect(mockNavigate).not.toHaveBeenCalled();
      } finally {
        mockDiscord.enabled = false;
      }
    });

    it("reports an action rather than a connection state", () => {
      // This page is org-scoped and a Discord link is per-member, so it cannot
      // honestly say "Not connected" the way the GitHub card can.
      mockDiscord.enabled = true;
      try {
        renderRoute({ availability: { state: "enabled" }, repos: [] });
        expect(screen.getByText("Add to a server")).toBeInTheDocument();
      } finally {
        mockDiscord.enabled = false;
      }
    });
  });

  it("redirects to Settings when there is no active organization", () => {
    renderRoute({
      availability: { state: "enabled" },
      activeOrganizationId: null,
    });
    expect(screen.getByText("Settings Screen")).toBeInTheDocument();
  });
});
