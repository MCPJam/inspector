import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { SandboxBuilderView } from "../SandboxBuilderView";
import { SANDBOX_STARTERS } from "../drafts";

const { mockUseSandbox, mockChatTabV2 } = vi.hoisted(() => ({
  mockUseSandbox: vi.fn(() => ({ sandbox: null })),
  mockChatTabV2: vi.fn(),
}));

vi.mock("sonner", () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}));

vi.mock("convex/react", () => ({
  useConvexAuth: () => ({ isAuthenticated: true }),
}));

vi.mock("@/hooks/useSandboxes", () => ({
  useSandbox: (...args: unknown[]) => mockUseSandbox(...args),
  useSandboxMutations: () => ({
    createSandbox: vi.fn(),
    updateSandbox: vi.fn(),
    setSandboxMode: vi.fn(),
  }),
}));

vi.mock("@/hooks/useWorkspaces", () => ({
  useServerMutations: () => ({ createServer: vi.fn() }),
}));

vi.mock("@/hooks/use-mobile", () => ({
  useIsMobile: () => false,
}));

vi.mock("@/hooks/hosted/use-hosted-oauth-gate", () => ({
  useHostedOAuthGate: () => ({
    oauthStateByServerId: {},
    pendingOAuthServers: [],
    authorizeServer: vi.fn(),
    markOAuthRequired: vi.fn(),
    hasBusyOAuth: false,
  }),
}));

vi.mock("@/lib/oauth/mcp-oauth", () => ({
  getStoredTokens: () => null,
}));

vi.mock("@/lib/sandbox-session", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/sandbox-session")>();
  return {
    ...actual,
    writeBuilderSession: vi.fn(),
    writePlaygroundSession: vi.fn(),
  };
});

vi.mock("@/components/ChatTabV2", () => ({
  ChatTabV2: (props: { loadingIndicatorVariant?: string }) => {
    mockChatTabV2(props);
    return <div data-testid="chat-tab" />;
  },
}));

vi.mock("@/components/connection/AddServerModal", () => ({
  AddServerModal: () => null,
}));

vi.mock("../SandboxCanvas", () => ({
  SandboxCanvas: () => <div data-testid="sandbox-canvas" />,
}));

const httpsServer = {
  _id: "srv-1",
  workspaceId: "ws-1",
  name: "Test MCP",
  enabled: true,
  transportType: "http" as const,
  url: "https://example.com/mcp",
  createdAt: 1,
  updatedAt: 1,
};

function createSavedSandbox(hostStyle: "claude" | "chatgpt") {
  return {
    sandboxId: `sbx-${hostStyle}`,
    workspaceId: "ws-1",
    name: `${hostStyle} sandbox`,
    description: "",
    hostStyle,
    systemPrompt: "You are helpful.",
    modelId: "openai/gpt-5-mini",
    temperature: 0.7,
    requireToolApproval: false,
    allowGuestAccess: false,
    mode: "any_signed_in_with_link" as const,
    servers: [],
    link: {
      token: `token-${hostStyle}`,
      path: `/sandbox/${hostStyle}`,
      url: `https://example.com/sandbox/${hostStyle}`,
      rotatedAt: 1,
    },
    members: [],
    welcomeDialog: { enabled: true, body: "" },
    feedbackDialog: {
      enabled: true,
      everyNToolCalls: 1,
      promptHint: "",
    },
  };
}

describe("SandboxBuilderView", () => {
  beforeEach(() => {
    mockUseSandbox.mockReset();
    mockUseSandbox.mockReturnValue({ sandbox: null });
    mockChatTabV2.mockReset();
  });

  it("exposes return navigation as an icon button with a descriptive label", () => {
    const draft = SANDBOX_STARTERS.find((s) => s.id === "blank")!.createDraft(
      "openai/gpt-5-mini",
    );
    render(
      <SandboxBuilderView
        workspaceId="ws-1"
        workspaceServers={[httpsServer]}
        draft={draft}
        onBack={() => {}}
        onSavedDraft={() => {}}
      />,
    );

    expect(
      screen.getByRole("button", { name: "Return to sandboxes" }),
    ).toBeInTheDocument();
  });

  it("shows setup-mode bottom CTA only in setup mode", () => {
    const draft = SANDBOX_STARTERS.find((s) => s.id === "blank")!.createDraft(
      "openai/gpt-5-mini",
    );
    render(
      <SandboxBuilderView
        workspaceId="ws-1"
        workspaceServers={[httpsServer]}
        draft={draft}
        onBack={() => {}}
        onSavedDraft={() => {}}
      />,
    );

    const cta = screen.getByRole("button", { name: "Save and open preview" });
    expect(cta).toBeInTheDocument();
    expect(cta).toBeDisabled();
    expect(screen.getByRole("button", { name: /^Save$/i })).toBeDisabled();
  });

  it("enables the setup bottom CTA when no setup sections need attention", () => {
    const base = SANDBOX_STARTERS.find((s) => s.id === "blank")!.createDraft(
      "openai/gpt-5-mini",
    );
    const draft = {
      ...base,
      selectedServerIds: [httpsServer._id],
    };
    render(
      <SandboxBuilderView
        workspaceId="ws-1"
        workspaceServers={[httpsServer]}
        draft={draft}
        onBack={() => {}}
        onSavedDraft={() => {}}
      />,
    );

    expect(
      screen.getByRole("button", { name: "Save and open preview" }),
    ).not.toBeDisabled();
    expect(screen.getByRole("button", { name: /^Save$/i })).not.toBeDisabled();
  });

  it("disables Preview and Usage until the sandbox is saved", () => {
    const draft = SANDBOX_STARTERS.find((s) => s.id === "blank")!.createDraft(
      "openai/gpt-5-mini",
    );
    render(
      <SandboxBuilderView
        workspaceId="ws-1"
        workspaceServers={[httpsServer]}
        draft={draft}
        onBack={() => {}}
        onSavedDraft={() => {}}
      />,
    );

    expect(screen.getByRole("button", { name: "Preview" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Usage" })).toBeDisabled();
  });

  it("renders the setup checklist on desktop while in setup mode", () => {
    const draft = SANDBOX_STARTERS.find((s) => s.id === "blank")!.createDraft(
      "openai/gpt-5-mini",
    );
    render(
      <SandboxBuilderView
        workspaceId="ws-1"
        workspaceServers={[httpsServer]}
        draft={draft}
        onBack={() => {}}
        onSavedDraft={() => {}}
      />,
    );

    expect(screen.getByRole("button", { name: /Basics/i })).toBeInTheDocument();
    expect(screen.getByTestId("sandbox-canvas")).toBeInTheDocument();
  });

  it("passes the pulsing dot loading variant for ChatGPT builder previews", () => {
    const sandbox = createSavedSandbox("chatgpt");
    mockUseSandbox.mockReturnValue({ sandbox });

    render(
      <SandboxBuilderView
        workspaceId="ws-1"
        workspaceServers={[httpsServer]}
        sandboxId={sandbox.sandboxId}
        initialViewMode="preview"
        onBack={() => {}}
        onSavedDraft={() => {}}
      />,
    );

    expect(screen.getByTestId("chat-tab")).toBeInTheDocument();
    expect(mockChatTabV2).toHaveBeenCalledWith(
      expect.objectContaining({
        loadingIndicatorVariant: "chatgpt-dot",
      }),
    );
  });

  it("passes the Claude mark variant to Claude builder previews", () => {
    const sandbox = createSavedSandbox("claude");
    mockUseSandbox.mockReturnValue({ sandbox });

    render(
      <SandboxBuilderView
        workspaceId="ws-1"
        workspaceServers={[httpsServer]}
        sandboxId={sandbox.sandboxId}
        initialViewMode="preview"
        onBack={() => {}}
        onSavedDraft={() => {}}
      />,
    );

    expect(screen.getByTestId("chat-tab")).toBeInTheDocument();
    expect(mockChatTabV2).toHaveBeenCalledWith(
      expect.objectContaining({
        loadingIndicatorVariant: "claude-mark",
      }),
    );
  });
});
