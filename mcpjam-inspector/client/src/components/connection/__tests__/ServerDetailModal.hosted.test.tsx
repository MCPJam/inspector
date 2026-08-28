import { describe, expect, it, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { toast } from "sonner";
import type { ServerWithName } from "@/hooks/use-app-state";

const mockFetchHostedOAuthTokens = vi.hoisted(() => vi.fn());

vi.mock("@workos-inc/authkit-react", () => ({
  useAuth: () => ({ user: { email: "tester@example.com" } }),
}));

vi.mock("@/lib/config", () => ({
  HOSTED_MODE: true,
}));

vi.mock("posthog-js/react", () => ({
  usePostHog: () => ({
    capture: vi.fn(),
  }),
  useFeatureFlagEnabled: () => false,
}));

vi.mock("@/lib/analytics", () => ({
  track: vi.fn(),
}));

vi.mock("convex/react", () => ({
  useQuery: () => undefined,
  useMutation: () => vi.fn(),
  useAction: () => vi.fn(),
}));

vi.mock("sonner", () => ({
  toast: {
    error: vi.fn(),
  },
}));

vi.mock("@/lib/apis/mcp-tools-api", () => ({
  listTools: vi.fn().mockResolvedValue({ tools: [], toolsMetadata: {} }),
}));

vi.mock("@/lib/apis/hosted-oauth-tokens-api", () => ({
  fetchHostedOAuthTokens: (...args: unknown[]) =>
    mockFetchHostedOAuthTokens(...args),
}));

vi.mock("@/lib/mcp-ui/mcp-apps-utils", () => ({
  isMCPApp: () => false,
  isOpenAIApp: () => false,
  isOpenAIAppAndMCPApp: () => false,
  UIType: {
    MCP_APPS: "mcp-apps",
    OPENAI_SDK: "openai-sdk",
    OPENAI_SDK_AND_MCP_APPS: "openai-sdk-and-mcp-apps",
    MCP_UI: "mcp-ui",
  },
}));

import { ServerDetailModal } from "../ServerDetailModal";

function createServer(
  overrides: Partial<ServerWithName> = {},
): ServerWithName {
  return {
    name: "test-server",
    lastConnectionTime: new Date(),
    connectionStatus: "disconnected",
    enabled: true,
    retryCount: 0,
    useOAuth: false,
    config: {
      url: "https://example.com/mcp",
    },
    ...overrides,
  };
}

describe("ServerDetailModal hosted reconnect", () => {
  const defaultProps = {
    isOpen: true,
    onClose: vi.fn(),
    server: createServer(),
    defaultTab: "configuration" as const,
    onSubmit: vi.fn().mockResolvedValue({
      ok: true,
      serverName: "test-server",
    }),
    onDisconnect: vi.fn(),
    onReconnect: vi.fn().mockResolvedValue(undefined),
    existingServerNames: ["test-server"],
  };

  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    Object.defineProperty(navigator, "clipboard", {
      value: {
        writeText: vi.fn().mockResolvedValue(undefined),
      },
      configurable: true,
    });
  });

  it("allows interactive OAuth reconnect for OAuth servers without tokens", () => {
    const onReconnect = vi.fn().mockResolvedValue(undefined);

    render(
      <ServerDetailModal
        {...defaultProps}
        server={createServer({ useOAuth: true })}
        onReconnect={onReconnect}
      />,
    );

    fireEvent.click(screen.getByRole("switch"));

    expect(onReconnect).toHaveBeenCalledWith("test-server", {
      allowInteractiveOAuthFlow: true,
    });
  });

  it("blocks the connect switch for transports the cloud cannot reach", () => {
    // The card's switch already refused these; this modal's switch was a
    // separate control that never learned the rule, so the same impossible
    // attempt could still be started from the detail view.
    for (const [label, config] of [
      ["insecure http", { url: "http://example.com/mcp" }],
      ["legacy stdio", { command: "npx", args: ["-y", "some-server"] }],
    ] as const) {
      const onReconnect = vi.fn().mockResolvedValue(undefined);
      const { unmount } = render(
        <ServerDetailModal
          {...defaultProps}
          server={createServer({ name: label, config: config as any })}
          onReconnect={onReconnect}
        />,
      );

      // Enabled, not disabled — see the component comment. A disabled
      // switch swallows the click and explains nothing; this one explains.
      fireEvent.click(screen.getByRole("switch"));
      expect(onReconnect).not.toHaveBeenCalled();
      expect(toast.error).toHaveBeenCalled();
      unmount();
      vi.clearAllMocks();
    }
  });

  it("still disconnects an unsupported server that is somehow connected", () => {
    // The reason the guard cannot simply disable the switch. Blocking the
    // control blocks BOTH directions, and a connected server with no way
    // to turn it off is a worse state than the one the guard prevents.
    // Only connecting is impossible here; disconnecting always works.
    const onDisconnect = vi.fn();
    render(
      <ServerDetailModal
        {...defaultProps}
        server={createServer({
          name: "legacy-stdio",
          connectionStatus: "connected",
          config: { command: "npx", args: ["-y", "some-server"] } as any,
        })}
        onDisconnect={onDisconnect}
      />,
    );

    fireEvent.click(screen.getByRole("switch"));

    expect(onDisconnect).toHaveBeenCalledWith("legacy-stdio");
  });

  it("shows the retry count, matching the card", () => {
    // One server reading `Failed (3)` on its card and a bare `Failed` in
    // its own modal is the kind of disagreement that makes a user trust
    // neither number.
    render(
      <ServerDetailModal
        {...defaultProps}
        server={createServer({
          connectionStatus: "failed",
          retryCount: 3,
          lastError: "fetch failed",
        })}
      />,
    );

    expect(screen.getByText("Failed (3)")).toBeInTheDocument();
  });

  it("reveals vault-backed OAuth tokens on demand without writing localStorage", async () => {
    const user = userEvent.setup();
    const writeTextSpy = vi
      .spyOn(navigator.clipboard, "writeText")
      .mockResolvedValue(undefined);
    const setItemSpy = vi.spyOn(Storage.prototype, "setItem");
    mockFetchHostedOAuthTokens.mockResolvedValue({
      tokens: {
        access_token: "hosted-access-token",
        refresh_token: "hosted-refresh-token",
        id_token: "hosted-id-token",
        token_type: "Bearer",
        expires_in: 3600,
        scope: "read write",
      },
      expiresAt: 1_900_000_000_000,
      kind: "generic",
    });

    render(
      <ServerDetailModal
        {...defaultProps}
        server={createServer({
          connectionStatus: "connected",
          useOAuth: true,
        })}
        defaultTab="overview"
        projectId="jh7abc123def456ghi789jk"
        hostedServerId="server_123"
      />,
    );

    expect(
      screen.queryByText(/OAuth credential is stored in Vault/),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Reveal tokens" }),
    ).toBeInTheDocument();
    expect(screen.queryByText("hosted-access-token")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Reveal tokens" }));

    await waitFor(() => {
      expect(mockFetchHostedOAuthTokens).toHaveBeenCalledWith({
        projectId: "jh7abc123def456ghi789jk",
        serverId: "server_123",
      });
    });
    expect(screen.getAllByText("****************").length).toBeGreaterThan(0);
    expect(screen.queryByText("hosted-access-token")).not.toBeInTheDocument();
    expect(screen.queryByText(/Source: Vault/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Expires in:/)).not.toBeInTheDocument();

    await user.click(
      screen.getByRole("button", { name: "Reveal Access Token" }),
    );
    expect(screen.getByText("hosted-access-token")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Copy Access Token" }));
    expect(writeTextSpy).toHaveBeenCalledWith("hosted-access-token");
    expect(setItemSpy).not.toHaveBeenCalled();
    expect(localStorage.getItem("mcp-tokens-test-server")).toBeNull();
    writeTextSpy.mockRestore();
    setItemSpy.mockRestore();
  });

  it("renders inline errors when hosted OAuth token reveal fails", async () => {
    const user = userEvent.setup();
    mockFetchHostedOAuthTokens.mockRejectedValue(
      new Error("No hosted OAuth credential found"),
    );

    render(
      <ServerDetailModal
        {...defaultProps}
        server={createServer({
          connectionStatus: "connected",
          useOAuth: true,
        })}
        defaultTab="overview"
        projectId="jh7abc123def456ghi789jk"
        hostedServerId="server_123"
      />,
    );

    await user.click(screen.getByRole("button", { name: "Reveal tokens" }));

    expect(
      await screen.findByText("No hosted OAuth credential found"),
    ).toBeInTheDocument();
  });
});
