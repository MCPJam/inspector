import { describe, expect, it, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import { fireEvent, render, screen, within } from "@testing-library/react";
import {
  computeSectionStatuses,
  ServerSelectionEditor,
  SetupChecklistPanel,
} from "../setup-checklist-panel";
import { CHATBOX_STARTERS } from "../drafts";
import type { RemoteServer } from "@/hooks/useWorkspaces";

vi.mock("@/lib/chatbox-host-style", () => ({
  getChatboxHostLogo: () => "/mock-host-logo.png",
  getChatboxHostStyleShortLabel: (hostStyle: string) =>
    hostStyle === "claude" ? "Claude" : "ChatGPT",
}));

vi.mock("@workos-inc/authkit-react", () => ({
  useAuth: () => ({
    user: {
      firstName: "Ignacio",
      lastName: "Jimenez",
      email: "ignacio@mcpjam.com",
    },
  }),
}));

vi.mock("@/hooks/useProfilePicture", () => ({
  useProfilePicture: () => ({ profilePictureUrl: null }),
}));

const baseDraft = CHATBOX_STARTERS.find((s) => s.id === "blank")!.createDraft(
  "openai/gpt-5-mini"
);
const stagedInviteProps = {
  stagedAccessInviteEmails: [],
  onStagedAccessInviteEmailAdd: vi.fn(),
  onStagedAccessInviteEmailRemove: vi.fn(),
};

describe("SetupChecklistPanel", () => {
  it("does not render the Setup header row on desktop (no onCloseMobile)", () => {
    render(
      <SetupChecklistPanel
        {...stagedInviteProps}
        chatboxDraft={baseDraft}
        savedChatbox={null}
        workspaceServers={[]}
        focusedSection={null}
        isUnsavedNewDraft
        onDraftChange={() => {}}
        onOpenAddServer={() => {}}
        onToggleServer={() => {}}
      />
    );

    expect(
      screen.queryByRole("heading", { name: "Setup" })
    ).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Basics/i })).toBeInTheDocument();
  });

  it("shows a subdued checkmark label with Done for complete sections (not a colored pill)", () => {
    render(
      <SetupChecklistPanel
        {...stagedInviteProps}
        chatboxDraft={baseDraft}
        savedChatbox={null}
        workspaceServers={[]}
        focusedSection={null}
        isUnsavedNewDraft
        onDraftChange={() => {}}
        onOpenAddServer={() => {}}
        onToggleServer={() => {}}
      />
    );

    const basicsRow = screen.getByRole("button", { name: /Basics/i });
    expect(within(basicsRow).getByText("Done")).toBeInTheDocument();
    expect(
      within(basicsRow).queryByText("Complete", { exact: true })
    ).not.toBeInTheDocument();
  });

  it("uses the same muted inline template for Optional, Default on, and Collapsed (no secondary badges)", () => {
    render(
      <SetupChecklistPanel
        {...stagedInviteProps}
        chatboxDraft={{
          ...baseDraft,
          welcomeDialog: { ...baseDraft.welcomeDialog, enabled: false },
        }}
        savedChatbox={null}
        workspaceServers={[]}
        focusedSection={null}
        isUnsavedNewDraft
        onDraftChange={() => {}}
        onOpenAddServer={() => {}}
        onToggleServer={() => {}}
      />
    );

    const welcomeRow = screen.getByRole("button", {
      name: /Welcome Dialog Optional/i,
    });
    expect(within(welcomeRow).getByText("Optional")).toBeInTheDocument();
    expect(welcomeRow.querySelector('[data-slot="badge"]')).toBeNull();

    const feedbackRow = screen.getByRole("button", {
      name: /Feedback Default on/i,
    });
    expect(within(feedbackRow).getByText("Default on")).toBeInTheDocument();
    expect(feedbackRow.querySelector('[data-slot="badge"]')).toBeNull();

    const advancedRow = screen.getByRole("button", {
      name: /Advanced Collapsed/i,
    });
    expect(within(advancedRow).getByText("Collapsed")).toBeInTheDocument();
    expect(advancedRow.querySelector('[data-slot="badge"]')).toBeNull();
  });

  it("renders mobile Done header when onCloseMobile is provided", () => {
    render(
      <SetupChecklistPanel
        {...stagedInviteProps}
        chatboxDraft={baseDraft}
        savedChatbox={null}
        workspaceServers={[]}
        focusedSection={null}
        isUnsavedNewDraft
        onDraftChange={() => {}}
        onOpenAddServer={() => {}}
        onToggleServer={() => {}}
        onCloseMobile={() => {}}
      />
    );

    expect(screen.getByRole("heading", { name: "Setup" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Done" })).toBeInTheDocument();
  });

  it("shows draft access controls inline in Access (no General access heading)", async () => {
    const user = userEvent.setup();
    render(
      <SetupChecklistPanel
        {...stagedInviteProps}
        chatboxDraft={baseDraft}
        savedChatbox={null}
        workspaceServers={[]}
        workspaceName="Acme"
        focusedSection={null}
        isUnsavedNewDraft
        onDraftChange={() => {}}
        onOpenAddServer={() => {}}
        onToggleServer={() => {}}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: /Access/i }));
    expect(screen.queryByText("General access")).not.toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Acme" }));
    expect(screen.getByText("Invited users only")).toBeInTheDocument();
    expect(
      screen.getByText("Anyone with the link (guests included)")
    ).toBeInTheDocument();
  });

  it("shows enabled Invite button pre-save and disabled when input is empty", () => {
    const internalDraft = CHATBOX_STARTERS.find(
      (s) => s.id === "internal-qa"
    )!.createDraft("openai/gpt-5-mini");
    render(
      <SetupChecklistPanel
        {...stagedInviteProps}
        chatboxDraft={internalDraft}
        savedChatbox={null}
        workspaceServers={[]}
        focusedSection={null}
        isUnsavedNewDraft
        onDraftChange={() => {}}
        onOpenAddServer={() => {}}
        onToggleServer={() => {}}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: /Access/i }));
    const emailInput = screen.getByLabelText(/invite with email/i);
    expect(emailInput).toBeEnabled();
    const inviteButton = screen.getByRole("button", { name: /^Invite$/i });
    expect(inviteButton).toBeDisabled();

    fireEvent.change(emailInput, { target: { value: "test@example.com" } });
    expect(inviteButton).toBeEnabled();
  });

  it("calls onStagedAccessInviteEmailAdd when Invite is clicked pre-save", () => {
    const onAdd = vi.fn();
    const internalDraft = CHATBOX_STARTERS.find(
      (s) => s.id === "internal-qa"
    )!.createDraft("openai/gpt-5-mini");
    render(
      <SetupChecklistPanel
        stagedAccessInviteEmails={[]}
        onStagedAccessInviteEmailAdd={onAdd}
        onStagedAccessInviteEmailRemove={vi.fn()}
        chatboxDraft={internalDraft}
        savedChatbox={null}
        workspaceServers={[]}
        focusedSection={null}
        isUnsavedNewDraft
        onDraftChange={() => {}}
        onOpenAddServer={() => {}}
        onToggleServer={() => {}}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: /Access/i }));
    fireEvent.change(screen.getByLabelText(/invite with email/i), {
      target: { value: "hello@example.com" },
    });
    fireEvent.click(screen.getByRole("button", { name: /^Invite$/i }));
    expect(onAdd).toHaveBeenCalledWith("hello@example.com");
  });

  it("renders staged emails as a removable list", async () => {
    const user = userEvent.setup();
    const onRemove = vi.fn();
    const internalDraft = CHATBOX_STARTERS.find(
      (s) => s.id === "internal-qa"
    )!.createDraft("openai/gpt-5-mini");
    render(
      <SetupChecklistPanel
        stagedAccessInviteEmails={["alice@example.com", "bob@example.com"]}
        onStagedAccessInviteEmailAdd={vi.fn()}
        onStagedAccessInviteEmailRemove={onRemove}
        chatboxDraft={internalDraft}
        savedChatbox={null}
        workspaceServers={[]}
        focusedSection={null}
        isUnsavedNewDraft
        onDraftChange={() => {}}
        onOpenAddServer={() => {}}
        onToggleServer={() => {}}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: /Access/i }));
    expect(screen.getByText("alice@example.com")).toBeInTheDocument();
    expect(screen.getByText("bob@example.com")).toBeInTheDocument();
    await user.click(screen.getAllByRole("button", { name: /Pending/i })[0]);
    await user.click(screen.getByRole("menuitem", { name: /Cancel invite/i }));
    expect(onRemove).toHaveBeenCalledWith("alice@example.com");
  });

  it("shows invite email field when inviteChatboxMember is wired (e.g. saved chatbox id)", () => {
    const internalDraft = CHATBOX_STARTERS.find(
      (s) => s.id === "internal-qa"
    )!.createDraft("openai/gpt-5-mini");
    render(
      <SetupChecklistPanel
        {...stagedInviteProps}
        chatboxDraft={internalDraft}
        savedChatbox={null}
        workspaceServers={[]}
        focusedSection={null}
        isUnsavedNewDraft
        onDraftChange={() => {}}
        onOpenAddServer={() => {}}
        onToggleServer={() => {}}
        inviteChatboxMember={async () => {}}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: /Access/i }));
    expect(screen.getByLabelText(/invite with email/i)).toBeInTheDocument();
    expect(screen.getByPlaceholderText(/add people/i)).toBeInTheDocument();
  });
});

describe("ServerSelectionEditor", () => {
  const httpServer: RemoteServer = {
    _id: "srv-1",
    workspaceId: "ws-1",
    name: "Linear MCP",
    enabled: true,
    transportType: "http",
    url: "https://mcp.linear.app/mcp",
    useOAuth: true,
  };

  const httpServerB: RemoteServer = {
    _id: "srv-2",
    workspaceId: "ws-1",
    name: "Other MCP",
    enabled: true,
    transportType: "http",
    url: "https://example.com/mcp",
    useOAuth: false,
  };

  it("lists selected servers with remove actions", () => {
    render(
      <ServerSelectionEditor
        workspaceServers={[httpServer, httpServerB]}
        selectedServerIds={[httpServer._id, httpServerB._id]}
        onToggleSelection={() => {}}
        onOpenAdd={() => {}}
      />
    );

    expect(screen.getByText("Linear MCP")).toBeInTheDocument();
    expect(screen.getByText("Other MCP")).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "Remove" })).toHaveLength(2);
  });
});

describe("computeSectionStatuses", () => {
  const httpsServer: RemoteServer = {
    _id: "srv-https",
    workspaceId: "ws-1",
    name: "HTTPS MCP",
    enabled: true,
    transportType: "http",
    url: "https://mcp.example.com/mcp",
    useOAuth: false,
  };

  it("marks servers as attention when every selected HTTPS server is optional", () => {
    const draft = {
      ...baseDraft,
      selectedServerIds: [httpsServer._id],
      optionalServerIds: [httpsServer._id],
    };
    const statuses = computeSectionStatuses(draft, [httpsServer]);
    expect(statuses.servers).toBe("attention");
  });

  it("marks servers as complete when at least one required HTTPS server is selected", () => {
    const draft = {
      ...baseDraft,
      selectedServerIds: [httpsServer._id],
      optionalServerIds: [],
    };
    const statuses = computeSectionStatuses(draft, [httpsServer]);
    expect(statuses.servers).toBe("complete");
  });
});
