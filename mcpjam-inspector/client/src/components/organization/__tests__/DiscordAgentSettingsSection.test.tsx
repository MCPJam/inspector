import { render, screen } from "@testing-library/react";
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

/** The connections table itself is covered by its own tests. */
vi.mock("../surface/SurfaceConnectionsTab", () => ({
  SurfaceConnectionsTab: ({ surfaceKind }: { surfaceKind: string }) => (
    <div data-testid="surface-connections">{surfaceKind}</div>
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
});
