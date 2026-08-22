import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  SharedSlackChannelCard,
  type SharedSlackChannelDto,
} from "../SharedSlackChannelCard";

const mockUseQuery = vi.fn();
const mockProvision = vi.fn();
const mockRefresh = vi.fn();
const flagMock = vi.fn();
const trackMock = vi.fn();
const toastError = vi.fn();
const toastSuccess = vi.fn();

vi.mock("convex/react", () => ({
  useQuery: (...args: unknown[]) => mockUseQuery(...args),
  useAction: (name: string) => {
    if (name === "orgSharedSlackChannelsNode:provision") return mockProvision;
    if (name === "orgSharedSlackChannelsNode:refreshStatus") return mockRefresh;
    return vi.fn();
  },
}));

vi.mock("@/hooks/useSharedSlackChannelEnabled", () => ({
  useSharedSlackChannelEnabled: () => flagMock(),
  SHARED_SLACK_CHANNEL_FEATURE_FLAG: "shared-slack-channel-enabled",
}));

vi.mock("@/lib/analytics", () => ({
  track: (...args: unknown[]) => trackMock(...args),
}));

vi.mock("@/lib/toast", () => ({
  toast: {
    error: (...args: unknown[]) => toastError(...args),
    success: (...args: unknown[]) => toastSuccess(...args),
  },
}));

function dto(
  overrides: Partial<SharedSlackChannelDto> & {
    channel?: SharedSlackChannelDto["channel"];
  } = {}
): SharedSlackChannelDto {
  return {
    channel: null,
    canProvision: true,
    canManageInvite: true,
    ...overrides,
  };
}

describe("SharedSlackChannelCard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    flagMock.mockReturnValue(true);
    mockRefresh.mockResolvedValue({ refreshed: false });
    mockProvision.mockResolvedValue({ status: "invite_sent" });
  });

  it("renders nothing when the flag is off", () => {
    flagMock.mockReturnValue(false);
    mockUseQuery.mockReturnValue(undefined);
    const { container } = render(
      <SharedSlackChannelCard organizationId="org_1" />
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("renders nothing when there is no organization", () => {
    mockUseQuery.mockReturnValue(undefined);
    const { container } = render(
      <SharedSlackChannelCard organizationId={null} />
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("shows a skeleton while the query is settling — never the empty-state", () => {
    mockUseQuery.mockReturnValue(undefined);
    render(<SharedSlackChannelCard organizationId="org_1" />);
    expect(
      screen.getByLabelText("Loading shared Slack channel")
    ).toBeInTheDocument();
    expect(
      screen.queryByText("Set up your shared Slack channel")
    ).not.toBeInTheDocument();
  });

  it("renders nothing for a member who cannot provision and has no row", () => {
    mockUseQuery.mockReturnValue(
      dto({ canProvision: false, canManageInvite: false, channel: null })
    );
    const { container } = render(
      <SharedSlackChannelCard organizationId="org_1" />
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("shows the setup CTA when the org has no channel and the viewer can provision", () => {
    mockUseQuery.mockReturnValue(dto());
    render(<SharedSlackChannelCard organizationId="org_1" />);
    expect(
      screen.getByText("Set up your shared Slack channel")
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Set up" })).toBeInTheDocument();
    expect(trackMock).toHaveBeenCalledWith("home_shared_slack_card_viewed", {
      location: "home",
      state: "none",
    });
  });

  it("shows a spinner while provisioning", () => {
    mockUseQuery.mockReturnValue(
      dto({
        channel: {
          status: "provisioning",
          openUrl: null,
        },
      })
    );
    render(<SharedSlackChannelCard organizationId="org_1" />);
    expect(
      screen.getByText("Setting up your shared Slack channel…")
    ).toBeInTheDocument();
  });

  it("shows invite_sent copy, expiry, and the accept link only when inviteUrl is present", () => {
    mockUseQuery.mockReturnValue(
      dto({
        channel: {
          status: "invite_sent",
          invitedEmail: "sam@acme.com",
          inviteExpiresAt: Date.UTC(2026, 8, 5),
          inviteUrl: "https://slack.com/invite",
          openUrl: null,
        },
      })
    );
    render(<SharedSlackChannelCard organizationId="org_1" />);
    const expectedExpiry = new Date(Date.UTC(2026, 8, 5)).toLocaleDateString(
      undefined,
      { month: "short", day: "numeric", year: "numeric" }
    );
    expect(
      screen.getByText(
        `Invite sent to sam@acme.com, expires ${expectedExpiry}.`
      )
    ).toBeInTheDocument();
    expect(
      screen.getByText(/Check your email for Slack's invite/)
    ).toBeInTheDocument();
    const inviteLink = screen.getByRole("link", {
      name: /Accept the invite in Slack/,
    });
    expect(inviteLink).toHaveAttribute("href", "https://slack.com/invite");
    fireEvent.click(inviteLink);
    expect(trackMock).toHaveBeenCalledWith("home_shared_slack_invite_opened", {
      location: "home",
      state: "invite_sent",
    });
    expect(mockRefresh).toHaveBeenCalledWith({ organizationId: "org_1" });
  });

  it("omits the accept link when inviteUrl is authorization-scoped away", () => {
    mockUseQuery.mockReturnValue(
      dto({
        canManageInvite: false,
        canProvision: false,
        channel: {
          status: "invite_sent",
          invitedEmail: "sam@acme.com",
          openUrl: null,
        },
      })
    );
    render(<SharedSlackChannelCard organizationId="org_1" />);
    expect(
      screen.queryByRole("link", { name: /Accept the invite in Slack/ })
    ).not.toBeInTheDocument();
    expect(screen.getByText(/Invite sent to sam@acme.com/)).toBeInTheDocument();
  });

  it("shows pending admin approval copy", () => {
    mockUseQuery.mockReturnValue(
      dto({
        channel: { status: "pending_admin_approval", openUrl: null },
      })
    );
    render(<SharedSlackChannelCard organizationId="org_1" />);
    expect(
      screen.getByText(/Waiting on your Slack workspace admin to approve/)
    ).toBeInTheDocument();
  });

  it("shows the open-channel link when active", () => {
    mockUseQuery.mockReturnValue(
      dto({
        channel: {
          status: "active",
          channelName: "ext-acme-mcpjam",
          openUrl: "https://app.slack.com/client/T1/C1",
        },
      })
    );
    render(<SharedSlackChannelCard organizationId="org_1" />);
    expect(screen.getByText("#ext-acme-mcpjam")).toBeInTheDocument();
    const channelLink = screen.getByRole("link", {
      name: /Open your shared Slack channel/,
    });
    expect(channelLink).toHaveAttribute(
      "href",
      "https://app.slack.com/client/T1/C1"
    );
    fireEvent.click(channelLink);
    expect(trackMock).toHaveBeenCalledWith("home_shared_slack_channel_opened", {
      location: "home",
      state: "active",
    });
  });

  it("shows per-code error copy and Retry for an admin", () => {
    mockUseQuery.mockReturnValue(
      dto({
        channel: {
          status: "error",
          errorCode: "slack_config",
          openUrl: null,
        },
      })
    );
    render(<SharedSlackChannelCard organizationId="org_1" />);
    expect(screen.getByText(/our team has been notified/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(trackMock).toHaveBeenCalledWith("home_shared_slack_retry_clicked", {
      location: "home",
      state: "error",
    });
    expect(mockProvision).toHaveBeenCalledWith({ organizationId: "org_1" });
  });

  it("hides Retry when the viewer cannot manage the invite", () => {
    mockUseQuery.mockReturnValue(
      dto({
        canManageInvite: false,
        canProvision: false,
        channel: {
          status: "invite_expired",
          errorCode: "invite_expired",
          openUrl: null,
        },
      })
    );
    render(<SharedSlackChannelCard organizationId="org_1" />);
    expect(
      screen.queryByRole("button", { name: "Retry" })
    ).not.toBeInTheDocument();
  });

  it("toasts ConvexError.data.message when provision fails", async () => {
    mockUseQuery.mockReturnValue(dto());
    mockProvision.mockRejectedValue({
      data: { code: "slack_connect_limit", message: "limit hit" },
    });
    render(<SharedSlackChannelCard organizationId="org_1" />);
    fireEvent.click(screen.getByRole("button", { name: "Set up" }));
    expect(trackMock).toHaveBeenCalledWith(
      "home_shared_slack_provision_clicked",
      { location: "home", state: "none" }
    );
    await vi.waitFor(() => {
      expect(toastError).toHaveBeenCalledWith("limit hit");
    });
  });
});
