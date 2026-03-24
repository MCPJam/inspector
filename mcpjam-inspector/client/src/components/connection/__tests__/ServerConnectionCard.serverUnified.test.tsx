import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ServerWithName } from "@/hooks/use-app-state";

vi.mock("@/lib/generate-agent-brief", () => ({
  generateAgentBrief: vi.fn().mockReturnValue("mocked brief"),
}));

const mockCapture = vi.fn();
vi.mock("posthog-js/react", () => ({
  usePostHog: () => ({
    capture: mockCapture,
  }),
  useFeatureFlagEnabled: () => false,
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

import { ServerConnectionCard } from "../ServerConnectionCard";

const mockClipboard = {
  writeText: vi.fn().mockResolvedValue(undefined),
};
Object.assign(navigator, { clipboard: mockClipboard });

describe("ServerConnectionCard detail modal trigger", () => {
  const createServer = (
    overrides: Partial<ServerWithName> = {},
  ): ServerWithName => ({
    name: "test-server",
    lastConnectionTime: new Date(),
    connectionStatus: "connected",
    enabled: true,
    retryCount: 0,
    useOAuth: false,
    config: {
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-test"],
    },
    ...overrides,
  });

  const defaultProps = {
    onDisconnect: vi.fn(),
    onReconnect: vi.fn().mockResolvedValue(undefined),
    onRemove: vi.fn(),
    onOpenDetailModal: vi.fn(),
  };

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("keeps pointer styling when the shared modal can be opened", () => {
    const { container } = render(
      <ServerConnectionCard server={createServer()} {...defaultProps} />,
    );

    const card = container.querySelector("[data-slot='card']");
    expect(card?.className).toContain("cursor-pointer");
  });

  it("card click requests the shared modal on configuration", () => {
    const { container } = render(
      <ServerConnectionCard server={createServer()} {...defaultProps} />,
    );

    const card = container.querySelector("[data-slot='card']");
    fireEvent.click(card!);

    expect(defaultProps.onOpenDetailModal).toHaveBeenCalledWith(
      expect.objectContaining({ name: "test-server" }),
      "configuration",
    );
    expect(mockCapture).toHaveBeenCalledWith(
      "server_card_clicked",
      expect.objectContaining({
        location: "server_connection_card",
        server_id: "test-server",
      }),
    );
    expect(mockCapture).toHaveBeenCalledWith(
      "server_detail_modal_opened",
      expect.objectContaining({
        source: "card_click",
        default_tab: "configuration",
        server_id: "test-server",
      }),
    );
  });

  it("configure menu item requests the shared modal on configuration", async () => {
    const user = userEvent.setup();
    render(<ServerConnectionCard server={createServer()} {...defaultProps} />);

    fireEvent.pointerDown(screen.getAllByRole("button")[0]);
    await user.click(await screen.findByText("Configure"));

    expect(defaultProps.onOpenDetailModal).toHaveBeenCalledWith(
      expect.objectContaining({ name: "test-server" }),
      "configuration",
    );
    expect(mockCapture).toHaveBeenCalledWith(
      "server_detail_modal_opened",
      expect.objectContaining({
        source: "kebab_edit",
        default_tab: "configuration",
        server_id: "test-server",
      }),
    );
  });

  it("switch click does not request the shared modal", () => {
    render(<ServerConnectionCard server={createServer()} {...defaultProps} />);

    fireEvent.click(screen.getByRole("switch"));

    expect(defaultProps.onOpenDetailModal).not.toHaveBeenCalled();
  });

  it("copy button does not request the shared modal", () => {
    render(<ServerConnectionCard server={createServer()} {...defaultProps} />);

    fireEvent.click(screen.getAllByRole("button")[1]);

    expect(defaultProps.onOpenDetailModal).not.toHaveBeenCalled();
  });

  it("error area click does not request the shared modal", () => {
    const { container } = render(
      <ServerConnectionCard
        server={createServer({
          connectionStatus: "failed",
          lastError: "Some error occurred",
          retryCount: 3,
        })}
        {...defaultProps}
      />,
    );

    const errorArea = container.querySelector("[class*='bg-red-500']");
    if (errorArea) {
      fireEvent.click(errorArea);
    }

    expect(defaultProps.onOpenDetailModal).not.toHaveBeenCalled();
  });
});
