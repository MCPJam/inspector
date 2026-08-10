import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach } from "vitest";

/**
 * The shared Activity feed.
 *
 * The case that matters most here is SURFACE FILTERING, because it is a fix
 * and not only a generalization: the backing query matches on both
 * `slack.agent.` and `discord.agent.` prefixes and always returned both, and
 * this tab used to render whatever it got with labels looked up by the full
 * action string. A Discord row therefore appeared in the SLACK tab as a raw
 * `discord.agent.channel_binding_created`, attributed to "Slack <a discord
 * user id>". These pin that each tab shows only its own rows, and that the
 * labels are shared rather than Slack-keyed.
 */

const { activity } = vi.hoisted(() => ({
  activity: {
    events: [] as Array<Record<string, unknown>>,
    isLoading: false,
    isLoadingMore: false,
    hasMore: false,
    error: null as unknown,
    refresh: vi.fn(),
    loadMore: vi.fn(),
  },
}));

vi.mock("convex/react", () => ({
  useConvexAuth: () => ({ isAuthenticated: true, isLoading: false }),
}));

vi.mock("@/hooks/useSlackAgentActivity", () => ({
  useSlackAgentActivity: () => activity,
}));

import { SurfaceActivityTab } from "../surface/SurfaceActivityTab";

function event(overrides: Record<string, unknown>) {
  return {
    _id: `e-${Math.abs(String(overrides.action).length)}-${String(
      overrides._id ?? "1"
    )}`,
    action: "slack.agent.channel_binding_created",
    actorType: "user",
    actorId: null,
    actorEmail: null,
    organizationId: "org-1",
    projectId: null,
    targetType: "surfaceChannelBinding",
    targetId: "b1",
    metadata: {},
    timestamp: 1_700_000_000_000,
    ...overrides,
  };
}

beforeEach(() => {
  activity.events = [];
  activity.isLoading = false;
  activity.isLoadingMore = false;
  activity.hasMore = false;
  activity.error = null;
});

describe("SurfaceActivityTab", () => {
  it("shows only the requested surface's rows", () => {
    activity.events = [
      event({ _id: "s", action: "slack.agent.channel_binding_created" }),
      event({ _id: "d", action: "discord.agent.channel_binding_created" }),
    ];

    render(<SurfaceActivityTab organizationId="org-1" surfaceKind="slack" />);
    expect(
      screen.getByTestId("activity-slack.agent.channel_binding_created")
    ).toBeInTheDocument();
    // The regression: this row used to render here, as a raw action string.
    expect(
      screen.queryByTestId("activity-discord.agent.channel_binding_created")
    ).not.toBeInTheDocument();
  });

  it("labels a Discord action from the shared map, not as a raw string", () => {
    activity.events = [
      event({ _id: "d", action: "discord.agent.channel_binding_created" }),
    ];

    render(<SurfaceActivityTab organizationId="org-1" surfaceKind="discord" />);
    expect(screen.getByText("Channel bound")).toBeInTheDocument();
    expect(
      screen.queryByText("discord.agent.channel_binding_created")
    ).not.toBeInTheDocument();
  });

  it("attributes an unlinked actor to the right surface", () => {
    activity.events = [
      event({
        _id: "d",
        action: "discord.agent.proposal_created",
        metadata: { proposerSurfaceUserId: "D_123" },
      }),
    ];

    render(<SurfaceActivityTab organizationId="org-1" surfaceKind="discord" />);
    // Previously "Slack D_123" — the id is a Discord one.
    expect(screen.getByText("Discord D_123")).toBeInTheDocument();
  });

  it("keeps Load more on an empty page when more pages exist", () => {
    // Filtering is client-side, so a page can be entirely the other surface.
    // Without the button this reads as "no activity", which would be wrong.
    activity.events = [
      event({ _id: "s", action: "slack.agent.channel_binding_created" }),
    ];
    activity.hasMore = true;

    render(<SurfaceActivityTab organizationId="org-1" surfaceKind="discord" />);
    expect(
      screen.getByRole("button", { name: "Load more" })
    ).toBeInTheDocument();
  });

  it("omits Load more on an empty page when there is nothing more", () => {
    activity.events = [];
    activity.hasMore = false;

    render(<SurfaceActivityTab organizationId="org-1" surfaceKind="discord" />);
    expect(
      screen.queryByRole("button", { name: "Load more" })
    ).not.toBeInTheDocument();
  });

  it("ignores the Slack-only legacy actor key on another surface", () => {
    // Not reachable today — `slackUserId` is written only by
    // `slackAccountLinks`, which emits `slack.agent.*`. Pinned anyway because
    // reading a surface-specific key on every surface is the shape of the bug
    // this component exists to remove.
    activity.events = [
      event({
        _id: "d",
        action: "discord.agent.account_linked",
        metadata: { slackUserId: "U_SLACK" },
      }),
    ];

    render(<SurfaceActivityTab organizationId="org-1" surfaceKind="discord" />);
    expect(screen.queryByText("Discord U_SLACK")).not.toBeInTheDocument();
    expect(screen.getByText("MCPJam")).toBeInTheDocument();
  });

  describe("retrying a failed page", () => {
    // `error` is one shared state for the first fetch and for `loadMore`, and
    // `refresh` resets the cursor. Once this tab began filtering, "no rows"
    // stopped meaning "nothing loaded" — so the two failures need telling
    // apart or a failed page hands the user a button that restarts paging.
    it("offers loadMore, not refresh, when a page failed but events exist", () => {
      activity.events = [
        event({ _id: "s", action: "slack.agent.channel_binding_created" }),
      ];
      activity.hasMore = true;
      activity.error = new Error("network");

      render(
        <SurfaceActivityTab organizationId="org-1" surfaceKind="discord" />
      );
      expect(
        screen.getByRole("button", { name: "Load more" })
      ).toBeInTheDocument();
      // "Try again" is the cursor-resetting refresh; it must not be the offer
      // here, or the user loops over the same page forever.
      expect(
        screen.queryByRole("button", { name: "Try again" })
      ).not.toBeInTheDocument();
    });

    it("still offers refresh when nothing loaded at all", () => {
      activity.events = [];
      activity.error = new Error("network");

      render(
        <SurfaceActivityTab organizationId="org-1" surfaceKind="discord" />
      );
      expect(
        screen.getByRole("button", { name: "Try again" })
      ).toBeInTheDocument();
    });
  });
});
