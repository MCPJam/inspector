import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { SandboxBuilderView } from "../SandboxBuilderView";
import { SANDBOX_STARTERS } from "../drafts";

vi.mock("sonner", () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}));

vi.mock("convex/react", () => ({
  useConvexAuth: () => ({ isAuthenticated: true }),
}));

vi.mock("@/hooks/useSandboxes", () => ({
  useSandbox: () => ({ sandbox: null }),
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
  ChatTabV2: () => <div data-testid="chat-tab" />,
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

describe("SandboxBuilderView", () => {
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

    expect(
      screen.getByRole("button", { name: "Save and open preview" }),
    ).toBeInTheDocument();
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
});
