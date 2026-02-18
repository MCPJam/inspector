import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { ServerConnectionCard } from "../ServerConnectionCard";
import type { ServerWithName } from "@/hooks/use-app-state";

vi.mock("@/lib/config", () => ({
  HOSTED_MODE: true,
}));

vi.mock("posthog-js/react", () => ({
  usePostHog: () => ({
    capture: vi.fn(),
  }),
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
  cleanupOrphanedTunnels: vi.fn().mockResolvedValue(undefined),
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

vi.mock("sonner", () => ({
  toast: {
    error: vi.fn(),
    success: vi.fn(),
    loading: vi.fn().mockReturnValue("toast-id"),
  },
}));

const HOSTED_HINT =
  "Hosted mode requires HTTPS server URLs. Edit this server to use https://.";

const createServer = (
  overrides: Partial<ServerWithName> = {},
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
  }) as ServerWithName;

describe("ServerConnectionCard hosted reconnect guard", () => {
  it("blocks reconnect switch for non-HTTPS servers in hosted mode", () => {
    const onReconnect = vi.fn().mockResolvedValue(undefined);
    const server = createServer();

    render(
      <ServerConnectionCard
        server={server}
        onDisconnect={vi.fn()}
        onReconnect={onReconnect}
        onEdit={vi.fn()}
      />,
    );

    expect(screen.getByText("HTTP blocked in hosted mode")).toBeInTheDocument();

    const toggle = screen.getByRole("switch");
    expect(toggle).toBeDisabled();
    expect(toggle).toHaveAttribute("title", HOSTED_HINT);

    fireEvent.click(toggle);
    expect(onReconnect).not.toHaveBeenCalled();
  });
});
