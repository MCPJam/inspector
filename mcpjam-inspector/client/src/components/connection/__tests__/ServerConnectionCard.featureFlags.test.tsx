import { describe, it, expect, vi, beforeEach } from "vitest";
import { render } from "@testing-library/react";
import type { ServerWithName } from "@/hooks/use-app-state";

// Mock the agent brief generator to avoid @mcpjam/sdk dependency
vi.mock("@/lib/generate-agent-brief", () => ({
  generateAgentBrief: vi.fn().mockReturnValue("mocked brief"),
}));

const useFeatureFlagEnabledMock = vi.fn();

vi.mock("posthog-js/react", () => ({
  usePostHog: () => ({ capture: vi.fn() }),
  useFeatureFlagEnabled: (...args: unknown[]) =>
    useFeatureFlagEnabledMock(...args),
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
  useConvexAuth: () => ({ isAuthenticated: true }),
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

const mockClipboard = { writeText: vi.fn().mockResolvedValue(undefined) };
Object.assign(navigator, { clipboard: mockClipboard });

const createServer = (
  overrides: Partial<ServerWithName> = {},
): ServerWithName => ({
  name: "test-server",
  connectionStatus: "connected",
  enabled: true,
  retryCount: 0,
  useOAuth: false,
  config: {
    transportType: "stdio",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-test"],
  },
  ...overrides,
});

const defaultProps = {
  onDisconnect: vi.fn(),
  onReconnect: vi.fn().mockResolvedValue(undefined),
  onEdit: vi.fn(),
  onRemove: vi.fn(),
};

describe("ServerConnectionCard feature flag gating", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useFeatureFlagEnabledMock.mockReturnValue(undefined);
  });

  it("calls useFeatureFlagEnabled with ci-evals-enabled", () => {
    useFeatureFlagEnabledMock.mockReturnValue(false);
    render(<ServerConnectionCard server={createServer()} {...defaultProps} />);

    expect(useFeatureFlagEnabledMock).toHaveBeenCalledWith("ci-evals-enabled");
  });

  // Note: Radix UI DropdownMenu does not open in jsdom, so we cannot
  // directly assert on dropdown menu item visibility. The dropdown content
  // is conditionally rendered with {ciEvalsEnabled && (...)}, and the
  // filterByFeatureFlags utility is tested thoroughly in
  // mcp-sidebar-feature-flags.test.ts.
});
