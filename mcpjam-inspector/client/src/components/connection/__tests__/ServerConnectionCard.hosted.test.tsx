import { describe, expect, it, vi } from "vitest";
import { errorToastMessage } from "@/test/utils";
import { fireEvent, render, screen } from "@testing-library/react";
import { toast } from "sonner";
import type { ServerWithName } from "@/hooks/use-app-state";

// Mock the agent brief generator to avoid @mcpjam/sdk dependency
vi.mock("@/lib/generate-agent-brief", () => ({
  generateAgentBrief: vi.fn().mockReturnValue("mocked brief"),
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

vi.mock("@/lib/apis/mcp-tools-api", () => ({
  listTools: vi.fn().mockResolvedValue({ tools: [], toolsMetadata: {} }),
}));

vi.mock("@/lib/apis/mcp-export-api", () => ({
  exportServerApi: vi.fn().mockResolvedValue({}),
}));

vi.mock("@/lib/apis/mcp-tunnels-api", () => ({
  getServerTunnel: vi.fn().mockResolvedValue(null),
  createServerTunnel: vi.fn().mockResolvedValue({
    url: "https://tunnel.example.com",
    serverId: "test-server",
  }),
  closeServerTunnel: vi.fn().mockResolvedValue(undefined),
  rotateServerTunnel: vi.fn().mockResolvedValue({
    url: "https://rotated.ngrok.app/api/mcp/adapter-http/test-server?k=newsecret",
    serverId: "test-server",
  }),
  getTunnelRequests: vi.fn().mockResolvedValue([]),
}));

vi.mock("@workos-inc/authkit-react", () => ({
  useAuth: () => ({
    getAccessToken: vi.fn().mockResolvedValue("test-token"),
  }),
}));

vi.mock("convex/react", () => ({
  useConvexAuth: () => ({
    isAuthenticated: true,
  }),
}));

vi.mock("@/hooks/use-explore-cases-prefetch-on-connect", () => ({
  useExploreCasesPrefetchOnConnect: vi.fn(),
}));

vi.mock("sonner", () => ({
  toast: {
    error: vi.fn(),
    success: vi.fn(),
    loading: vi.fn().mockReturnValue("toast-id"),
  },
}));

// Must import after mocks are set up
import { ServerConnectionCard } from "../ServerConnectionCard";

const createServer = (
  overrides: Partial<ServerWithName> = {}
): ServerWithName =>
  ({
    name: "insecure-http",
    connectionStatus: "disconnected",
    enabled: true,
    retryCount: 0,
    useOAuth: false,
    config: {
      transportType: "streamableHttp",
      url: "http://example.com/mcp",
    },
    ...overrides,
  } as ServerWithName);

describe("ServerConnectionCard hosted reconnect guard", () => {
  it("blocks reconnect switch for non-HTTPS servers in hosted mode", () => {
    const onReconnect = vi.fn().mockResolvedValue(undefined);
    const server = createServer();

    render(
      <ServerConnectionCard
        server={server}
        onDisconnect={vi.fn()}
        onReconnect={onReconnect}
      />
    );

    const toggle = screen.getByRole("switch");
    fireEvent.click(toggle);

    // One message for this condition across the whole app now. It was
    // "HTTP servers are not supported in hosted mode" here and the
    // actionable sentence below in the chip strip — two strings for one
    // rule. The actionable one won.
    expect(toast.error).toHaveBeenCalledWith(
      errorToastMessage(
        "Hosted mode requires HTTPS server URLs. Edit this server to use https://."
      ),
      { duration: 8000 }
    );
    expect(onReconnect).not.toHaveBeenCalled();
  });

  it("marks an http:// server with a neutral chip, not a failure", () => {
    render(
      <ServerConnectionCard
        server={createServer()}
        onDisconnect={vi.fn()}
        onReconnect={vi.fn().mockResolvedValue(undefined)}
      />
    );

    expect(screen.getByText("Needs HTTPS in cloud mode")).toBeInTheDocument();
    expect(screen.queryByText("Error")).not.toBeInTheDocument();
    expect(screen.queryByText("Check troubleshooting")).not.toBeInTheDocument();
  });

  it("blocks a legacy stdio server and says the cloud cannot run it", () => {
    const onReconnect = vi.fn().mockResolvedValue(undefined);
    // Hosted mode stops new stdio servers being CREATED, but rows that
    // predate it still exist in hosted projects, so the card has to handle
    // one.
    const server = createServer({
      name: "legacy-stdio",
      config: { command: "npx", args: ["-y", "some-server"] } as any,
    });

    render(
      <ServerConnectionCard
        server={server}
        onDisconnect={vi.fn()}
        onReconnect={onReconnect}
      />
    );

    expect(screen.getByText("Not available in cloud mode")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("switch"));

    expect(toast.error).toHaveBeenCalledWith(
      errorToastMessage(
        "STDIO servers run a local command, which the cloud deployment cannot do. Run MCPJam locally to connect this server."
      ),
      { duration: 8000 }
    );
    expect(onReconnect).not.toHaveBeenCalled();
  });

  it("allows interactive OAuth reconnect for OAuth servers without tokens", () => {
    const onReconnect = vi.fn().mockResolvedValue(undefined);
    const server = createServer({
      name: "oauth-server",
      useOAuth: true,
      config: {
        transportType: "streamableHttp",
        url: "https://example.com/mcp",
      },
    });

    render(
      <ServerConnectionCard
        server={server}
        onDisconnect={vi.fn()}
        onReconnect={onReconnect}
      />
    );

    fireEvent.click(screen.getByRole("switch"));

    expect(onReconnect).toHaveBeenCalledWith("oauth-server", {
      allowInteractiveOAuthFlow: true,
    });
  });

  it("hides the share CTA even for share-eligible hosted servers", () => {
    const server = createServer({
      name: "shareable-server",
      connectionStatus: "connected",
      config: {
        transportType: "streamableHttp",
        url: "https://example.com/mcp",
      },
    });

    render(
      <ServerConnectionCard
        server={server}
        hostedServerId="hosted-server-1"
        onDisconnect={vi.fn()}
        onReconnect={vi.fn().mockResolvedValue(undefined)}
      />
    );

    expect(
      screen.queryByRole("button", { name: "Share" })
    ).not.toBeInTheDocument();
  });
});
