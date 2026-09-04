import { render, screen, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { describe, expect, it, vi } from "vitest";

const {
  mockAvailability,
  mockRepos,
  mockNavigate,
  mockOrgsLoading,
  mockSlackConnections,
  mockDiscordConnections,
  mockSurfaceSettingsCalls,
  mockDiscord,
  mockObservability,
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
      { workspaces: Array<{ installed: boolean }> } | undefined,
  },
  mockDiscordConnections: {
    value: undefined as
      { workspaces: Array<{ installed: boolean }> } | undefined,
  },
  mockSurfaceSettingsCalls: {
    value: [] as Array<{
      organizationId: string | null;
      surfaceKind?: string;
    }>,
  },
  // Same recording as the Slack/Discord hook, for the same reason: the flag
  // has to reach the QUERY. A flagged-off visitor must not fire the
  // availability read at all.
  mockObservability: {
    enabled: false,
    calls: [] as Array<string | null | undefined>,
    listCalls: [] as Array<string | null | undefined>,
    availability: undefined as
      | { state: "enabled" | "disabled" | "unavailable"; canEdit: boolean }
      | undefined,
    destinations: undefined as
      Array<{ enabled: boolean; paused: unknown }> | undefined,
  },
  mockDiscord: {
    enabled: false,
    /** null models VITE_MCPJAM_DISCORD_CLIENT_ID being unset. */
    installUrl: "https://discord.com/oauth2/authorize?client_id=1" as
      string | null,
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
  // Surface-aware, because the Slack and Discord cards now read the same hook
  // with different arguments — a mock that ignored the kind would let a
  // Discord card silently render Slack's workspaces and still pass.
  //
  // Calls are RECORDED so a test can assert the flag reached the query, not
  // just the render: the hook skips on a null organization id, and that is
  // the only thing keeping a flagged-off visitor from firing a
  // `surfaceKind: "discord"` query at a backend that may reject it.
  useOrgSlackSettings: (
    organizationId: string | null,
    surfaceKind?: string,
  ) => {
    mockSurfaceSettingsCalls.value.push({ organizationId, surfaceKind });
    return {
      connections:
        surfaceKind === "discord"
          ? mockDiscordConnections.value
          : mockSlackConnections.value,
    };
  },
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

vi.mock("@/hooks/useDiscordAgentEnabled", () => ({
  useDiscordAgentEnabled: () => mockDiscord.enabled,
}));

vi.mock("@/lib/config", () => ({
  discordInstallUrl: () => mockDiscord.installUrl,
}));

vi.mock("@/hooks/useTraceDestinationsEnabled", () => ({
  useTraceDestinationsEnabled: () => mockObservability.enabled,
}));

vi.mock("@/hooks/useOrgTraceDestinations", () => ({
  useTraceDestinationsAvailability: (organizationId: string | null) => {
    mockObservability.calls.push(organizationId);
    // MODELS THE SKIP. The real hook passes "skip" to `useQuery` when the org
    // id is null and returns `undefined` — so a mock that answered anyway
    // would let the card behave as if the server had spoken when no query was
    // ever sent, which is the exact thing these tests exist to pin down.
    return organizationId === null ? undefined : mockObservability.availability;
  },
  // The LIST read is recorded too, not just availability. It is equally
  // org-scoped and signed-in, and equally throws on a backend that has not
  // deployed it — so a regression that fired it while flagged off, or for an
  // organization the server said no to, would otherwise pass every assertion
  // below while producing exactly the ErrorCard this gating exists to prevent.
  useOrgTraceDestinations: (organizationId: string | null) => {
    mockObservability.listCalls.push(organizationId);
    return { destinations: mockObservability.destinations };
  },
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
  discordEnabled?: boolean;
  discordInstallUrl?: string | null;
}) {
  mockAvailability.value = availability;
  mockAvailability.error = error;
  mockRepos.value = repos;
  mockSlackConnections.value = slackConnections;
  mockSurfaceSettingsCalls.value = [];
  mockObservability.calls = [];
  mockObservability.listCalls = [];
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

  describe("the Discord card", () => {
    it("is hidden while the agent flag is off", () => {
      // The agent is dark: the bot lives in one test guild and cannot answer
      // anyone else. Offering an install would invite a dead bot into a server.
      renderRoute({ availability: { state: "enabled" }, repos: [] });
      expect(screen.queryByText("Discord")).not.toBeInTheDocument();
    });

    it("does not query at all while the flag is off", () => {
      // A hook cannot be called conditionally, so the flag has to reach the
      // hook's own skip condition — an early `return null` happens after the
      // query has already fired. This is the one call that sends
      // `surfaceKind: "discord"`, which a backend deployed before that
      // argument existed rejects; the throw would surface as an ErrorCard to
      // a user who should see no Discord entry whatsoever.
      renderRoute({ availability: { state: "enabled" }, repos: [] });
      const discordCalls = mockSurfaceSettingsCalls.value.filter(
        (call) => call.surfaceKind === "discord",
      );
      expect(discordCalls.length).toBeGreaterThan(0);
      for (const call of discordCalls) {
        expect(call.organizationId).toBeNull();
      }
    });

    it("queries with the real org id once the flag is on", () => {
      mockDiscord.enabled = true;
      try {
        renderRoute({ availability: { state: "enabled" }, repos: [] });
        expect(mockSurfaceSettingsCalls.value).toContainEqual({
          organizationId: "org-1",
          surfaceKind: "discord",
        });
      } finally {
        mockDiscord.enabled = false;
      }
    });

    it("shows even without a client id — the card is no longer the install link", () => {
      // The install button moved onto the Discord settings page, next to the
      // server list it affects. A missing client id hides THAT button; it no
      // longer hides the whole entry, because the page still has a server
      // list and a default-project picker worth reaching.
      mockDiscord.enabled = true;
      mockDiscord.installUrl = null;
      try {
        renderRoute({ availability: { state: "enabled" }, repos: [] });
        expect(
          screen.getByTestId("integration-card-discord"),
        ).toBeInTheDocument();
      } finally {
        mockDiscord.enabled = false;
        mockDiscord.installUrl =
          "https://discord.com/oauth2/authorize?client_id=1";
      }
    });

    it("navigates IN-APP to the org's Discord settings, not out to Discord", () => {
      mockDiscord.enabled = true;
      try {
        renderRoute({ availability: { state: "enabled" }, repos: [] });
        const card = screen.getByTestId("integration-card-discord");
        // A button, not an anchor: the destination is ours now.
        expect(card.tagName).toBe("BUTTON");
        card.click();
        expect(mockNavigate).toHaveBeenCalledWith(
          "/organizations/org-1/discord",
        );
      } finally {
        mockDiscord.enabled = false;
        mockNavigate.mockClear();
      }
    });

    it("reports a connection state, like the other cards", () => {
      // It could not before: the card was org-scoped but Discord had no
      // org-scoped read, so it reported the ACTION instead. Now that
      // `getConnections` answers per surface, it can say the true thing.
      mockDiscord.enabled = true;
      mockDiscordConnections.value = {
        workspaces: [{ installed: true }, { installed: false }],
      };
      try {
        renderRoute({ availability: { state: "enabled" }, repos: [] });
        expect(screen.getByText("1 server connected")).toBeInTheDocument();
      } finally {
        mockDiscord.enabled = false;
        mockDiscordConnections.value = undefined;
      }
    });

    it("stays quiet while the read is in flight, rather than claiming none", () => {
      // Same rule as the Slack and GitHub cards: `undefined` is "still
      // asking", and "Not connected" in that window tells a connected org
      // their setup is gone.
      mockDiscord.enabled = true;
      mockDiscordConnections.value = undefined;
      try {
        renderRoute({ availability: { state: "enabled" }, repos: [] });
        // Scoped to THIS card: the GitHub card legitimately says "Not
        // connected" for `repos: []`, so an unscoped query would pass for the
        // wrong reason and keep passing if Discord regressed.
        const card = screen.getByTestId("integration-card-discord");
        expect(
          within(card).queryByText("Not connected"),
        ).not.toBeInTheDocument();
      } finally {
        mockDiscord.enabled = false;
      }
    });
  });

  describe("the Observability card", () => {
    it("renders nothing, and asks nothing, while the flag is off", () => {
      mockObservability.enabled = false;
      mockObservability.availability = { state: "enabled", canEdit: true };
      renderRoute({ availability: { state: "enabled" }, repos: [] });

      expect(
        screen.queryByTestId("integration-card-observability"),
      ).not.toBeInTheDocument();
      // The flag has to reach the QUERIES, not just the render: a flagged-off
      // visitor must fire NEITHER org-scoped signed-in read at a backend that
      // may not have deployed them yet.
      expect(mockObservability.calls).toEqual([null]);
      expect(mockObservability.listCalls).toEqual([null]);
    });

    it("stays hidden when the flag is on but the server says no", () => {
      mockObservability.enabled = true;
      mockObservability.availability = { state: "disabled", canEdit: true };
      try {
        renderRoute({ availability: { state: "enabled" }, repos: [] });
        expect(
          screen.queryByTestId("integration-card-observability"),
        ).not.toBeInTheDocument();
        expect(mockObservability.calls).toEqual(["org-1"]);
        // Availability was asked; the LIST was not. A "disabled" answer means
        // this organization has no destinations surface, so reading its
        // destinations would be a refusal waiting to happen.
        expect(mockObservability.listCalls).toEqual([null]);
      } finally {
        mockObservability.enabled = false;
      }
    });

    it("counts the destinations that are actually streaming", () => {
      mockObservability.enabled = true;
      mockObservability.availability = { state: "enabled", canEdit: true };
      mockObservability.destinations = [
        { enabled: true, paused: null },
        { enabled: false, paused: null },
      ];
      try {
        renderRoute({ availability: { state: "enabled" }, repos: [] });
        const card = screen.getByTestId("integration-card-observability");
        expect(
          within(card).getByText("1 destination streaming"),
        ).toBeInTheDocument();
      } finally {
        mockObservability.enabled = false;
        mockObservability.destinations = undefined;
      }
    });

    it("says a paused destination needs attention, ahead of any count", () => {
      mockObservability.enabled = true;
      mockObservability.availability = { state: "enabled", canEdit: true };
      mockObservability.destinations = [
        { enabled: true, paused: { at: 1, reason: "auth_failed" } },
      ];
      try {
        renderRoute({ availability: { state: "enabled" }, repos: [] });
        const card = screen.getByTestId("integration-card-observability");
        expect(
          within(card).getByText("Paused — needs attention"),
        ).toBeInTheDocument();
      } finally {
        mockObservability.enabled = false;
        mockObservability.destinations = undefined;
      }
    });

    it("stays quiet while the read is in flight, rather than claiming none", () => {
      mockObservability.enabled = true;
      mockObservability.availability = { state: "enabled", canEdit: true };
      mockObservability.destinations = undefined;
      try {
        renderRoute({ availability: { state: "enabled" }, repos: [] });
        const card = screen.getByTestId("integration-card-observability");
        expect(
          within(card).queryByText("Not configured"),
        ).not.toBeInTheDocument();
      } finally {
        mockObservability.enabled = false;
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
