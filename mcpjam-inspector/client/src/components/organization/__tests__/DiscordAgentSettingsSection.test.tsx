import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

/**
 * The Discord org-settings section.
 *
 * Two things are worth pinning beyond "it renders": the FLAG gate, because
 * this section is the only in-app surface for a bot that is still dark; and
 * the INSTALL-BUTTON gate, because an install URL built without a client id
 * lands on a Discord error page that reads as our bug.
 */

const { mockDiscord } = vi.hoisted(() => ({
  mockDiscord: {
    enabled: true,
    installUrl: "https://discord.com/oauth2/authorize?client_id=1" as
      | string
      | null,
  },
}));

vi.mock("@/hooks/useDiscordAgentEnabled", () => ({
  useDiscordAgentEnabled: () => mockDiscord.enabled,
}));

vi.mock("@/lib/config", () => ({
  discordInstallUrl: () => mockDiscord.installUrl,
}));

/** The panels themselves are covered by their own tests. */
vi.mock("../surface/SurfaceConnectionsTab", () => ({
  SurfaceConnectionsTab: ({ surfaceKind }: { surfaceKind: string }) => (
    <div data-testid="surface-connections">{surfaceKind}</div>
  ),
}));

vi.mock("../surface/SurfaceActivityTab", () => ({
  SurfaceActivityTab: ({ surfaceKind }: { surfaceKind: string }) => (
    <div data-testid="surface-activity">{surfaceKind}</div>
  ),
}));

import { DiscordAgentSettingsSection } from "../discord/DiscordAgentSettingsSection";

describe("DiscordAgentSettingsSection", () => {
  it("renders nothing when the agent flag is off", () => {
    mockDiscord.enabled = false;
    try {
      const { container } = render(
        <DiscordAgentSettingsSection organizationId="org-1" isAdmin />,
      );
      // Self-enforced, not just hidden by the nav strip: someone can type
      // /organizations/:id/discord directly.
      expect(container).toBeEmptyDOMElement();
    } finally {
      mockDiscord.enabled = true;
    }
  });

  it("renders the connections table for the DISCORD surface", () => {
    render(<DiscordAgentSettingsSection organizationId="org-1" isAdmin />);
    // Passing the wrong kind here would silently show Slack's rows.
    expect(screen.getByTestId("surface-connections")).toHaveTextContent(
      "discord",
    );
  });

  it("offers the install link to an admin", () => {
    render(<DiscordAgentSettingsSection organizationId="org-1" isAdmin />);
    const link = screen.getByRole("link", { name: "Add to a server" });
    expect(link).toHaveAttribute(
      "href",
      "https://discord.com/oauth2/authorize?client_id=1",
    );
    expect(link).toHaveAttribute("rel", "noreferrer");
  });

  it("hides the install link from a non-admin", () => {
    // Adding a bot to a server is an administrative act; a member seeing the
    // button would be offered something their role cannot complete.
    render(
      <DiscordAgentSettingsSection organizationId="org-1" isAdmin={false} />,
    );
    expect(
      screen.queryByRole("link", { name: "Add to a server" }),
    ).not.toBeInTheDocument();
  });

  it("hides the install link when no client id is configured", () => {
    mockDiscord.installUrl = null;
    try {
      render(<DiscordAgentSettingsSection organizationId="org-1" isAdmin />);
      // The rest of the page still renders — a server list and a default
      // project picker are worth reaching without an install button.
      expect(screen.getByTestId("surface-connections")).toBeInTheDocument();
      expect(
        screen.queryByRole("link", { name: "Add to a server" }),
      ).not.toBeInTheDocument();
    } finally {
      mockDiscord.installUrl =
        "https://discord.com/oauth2/authorize?client_id=1";
    }
  });

  describe("tabs", () => {
    it("offers Connections and Activity, and no Capabilities", () => {
      render(<DiscordAgentSettingsSection organizationId="org-1" isAdmin />);
      const tabs = screen
        .getAllByRole("tab")
        .map((tab) => tab.textContent?.trim());
      // Capabilities is org-wide in the backend, not per-surface — a Discord
      // tab would render a second control over the same single row.
      expect(tabs).toEqual(["Connections", "Activity"]);
    });

    it("defaults to Connections when no tab is given", () => {
      render(<DiscordAgentSettingsSection organizationId="org-1" isAdmin />);
      expect(screen.getByTestId("surface-connections")).toBeInTheDocument();
      expect(screen.queryByTestId("surface-activity")).not.toBeInTheDocument();
    });

    it("renders the Activity panel for the DISCORD surface", () => {
      render(
        <DiscordAgentSettingsSection
          organizationId="org-1"
          isAdmin
          tab="activity"
        />,
      );
      // The wrong kind here would show Slack's rows on the Discord page.
      expect(screen.getByTestId("surface-activity")).toHaveTextContent(
        "discord",
      );
    });

    it("falls back to Connections for a tab id it does not have", () => {
      // `?tab=capabilities` is a real Slack URL; carried onto Discord it must
      // land somewhere real rather than on an empty panel.
      render(
        <DiscordAgentSettingsSection
          organizationId="org-1"
          isAdmin
          tab="capabilities"
        />,
      );
      expect(screen.getByTestId("surface-connections")).toBeInTheDocument();
    });

    it("reports the selected tab to its caller", async () => {
      const onTabChange = vi.fn();
      render(
        <DiscordAgentSettingsSection
          organizationId="org-1"
          isAdmin
          onTabChange={onTabChange}
        />,
      );
      await userEvent.click(screen.getByRole("tab", { name: "Activity" }));
      // The section does not own the URL; OrganizationsTab writes `?tab=`.
      expect(onTabChange).toHaveBeenCalledWith("activity");
    });
  });
});
