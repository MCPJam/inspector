import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";
import {
  render,
  screen,
  fireEvent,
  waitFor,
  act,
} from "@testing-library/react";
import { toast } from "sonner";
import type { ServerWithName } from "@/hooks/use-app-state";

// Mock the agent brief generator to avoid @mcpjam/sdk dependency
vi.mock("@/lib/generate-agent-brief", () => ({
  generateAgentBrief: vi.fn().mockReturnValue("mocked brief"),
}));

// Mock posthog
vi.mock("posthog-js/react", () => ({
  usePostHog: () => ({
    capture: vi.fn(),
  }),
  useFeatureFlagEnabled: () => false,
}));

// Mock the APIs
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
    url: "https://rotated0001.tunnels.mcpjam.com/api/mcp/adapter-http/test-server?k=newsecret",
    serverId: "test-server",
  }),
  getTunnelRequests: vi.fn().mockResolvedValue([]),
}));

// Stable getAccessToken reference across renders — a fresh fn per render
// would make the card's tunnel-URL effects (which depend on getAccessToken)
// re-run on every re-render, masking the real polling cadence under test.
const mockGetAccessToken = vi.fn().mockResolvedValue("test-token");
vi.mock("@workos-inc/authkit-react", () => ({
  useAuth: () => ({
    getAccessToken: mockGetAccessToken,
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

// Mock sonner toast
vi.mock("sonner", () => ({
  toast: {
    error: vi.fn(),
    success: vi.fn(),
    warning: vi.fn(),
    loading: vi.fn().mockReturnValue("toast-id"),
  },
}));

// Must import after mocks are set up
import { ServerConnectionCard } from "../ServerConnectionCard";
import { TUNNEL_EXPLANATION_DISMISSED_KEY } from "../TunnelExplanationModal";
import { useExploreCasesPrefetchOnConnect } from "@/hooks/use-explore-cases-prefetch-on-connect";

// Mock navigator.clipboard
const mockClipboard = {
  writeText: vi.fn().mockResolvedValue(undefined),
};
Object.assign(navigator, { clipboard: mockClipboard });

describe("ServerConnectionCard", () => {
  const createServer = (
    overrides: Partial<ServerWithName> = {}
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
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("rendering", () => {
    it("calls explore prefetch hook with projectId and server", () => {
      const prefetch = vi.mocked(useExploreCasesPrefetchOnConnect);
      const server = createServer();
      render(
        <ServerConnectionCard
          server={server}
          projectId="ws_abc"
          {...defaultProps}
        />
      );
      expect(prefetch).toHaveBeenCalledWith("ws_abc", server, undefined);
    });

    it("calls explore prefetch hook with null project when prop omitted", () => {
      const prefetch = vi.mocked(useExploreCasesPrefetchOnConnect);
      const server = createServer();
      render(<ServerConnectionCard server={server} {...defaultProps} />);
      expect(prefetch).toHaveBeenCalledWith(null, server, undefined);
    });

    it("shows move targets in the actions menu and calls the move handler", async () => {
      const onMoveToProject = vi.fn();
      render(
        <ServerConnectionCard
          server={createServer()}
          {...defaultProps}
          moveTargets={[{ id: "project-2", name: "Target project" }]}
          onMoveToProject={onMoveToProject}
        />
      );

      fireEvent.pointerDown(
        screen.getByRole("button", {
          name: "Open actions menu for test-server",
        }),
        { button: 0, ctrlKey: false }
      );
      const moveTrigger = await screen.findByText("Move to project");
      fireEvent.keyDown(moveTrigger, { key: "ArrowRight" });

      const target = await screen.findByText("Target project");
      fireEvent.click(target);

      expect(onMoveToProject).toHaveBeenCalledWith("test-server", "project-2");
    });

    it("hides the move action when there are no target projects", () => {
      render(
        <ServerConnectionCard
          server={createServer()}
          {...defaultProps}
          moveTargets={[]}
          onMoveToProject={vi.fn()}
        />
      );

      fireEvent.pointerDown(
        screen.getByRole("button", {
          name: "Open actions menu for test-server",
        }),
        { button: 0, ctrlKey: false }
      );

      expect(screen.queryByText("Move to project")).not.toBeInTheDocument();
    });

    it("renders server name", () => {
      const server = createServer({ name: "my-server" });
      render(<ServerConnectionCard server={server} {...defaultProps} />);

      expect(screen.getByText("my-server")).toBeInTheDocument();
    });

    it("does not show details toggle", () => {
      const server = createServer();
      render(<ServerConnectionCard server={server} {...defaultProps} />);

      expect(screen.queryByText("Show details")).not.toBeInTheDocument();
    });

    it("renders command display for stdio transport", () => {
      const server = createServer({
        config: {
          command: "node",
          args: ["server.js"],
        },
      });
      render(<ServerConnectionCard server={server} {...defaultProps} />);

      expect(screen.getByText("node server.js")).toBeInTheDocument();
    });

    it("renders URL for http transport", () => {
      const server = createServer({
        config: {
          url: "http://localhost:3000/mcp",
        },
      });
      render(<ServerConnectionCard server={server} {...defaultProps} />);

      expect(screen.getByText("http://localhost:3000/mcp")).toBeInTheDocument();
    });
  });

  describe("connection status", () => {
    it("shows connected status indicator", () => {
      const server = createServer({ connectionStatus: "connected" });
      render(<ServerConnectionCard server={server} {...defaultProps} />);

      expect(screen.getByText("Connected")).toBeInTheDocument();
    });

    it("shows disconnected status indicator", () => {
      const server = createServer({ connectionStatus: "disconnected" });
      render(<ServerConnectionCard server={server} {...defaultProps} />);

      expect(screen.getByText("Disconnected")).toBeInTheDocument();
    });

    it("shows connecting status indicator", () => {
      const server = createServer({ connectionStatus: "connecting" });
      render(<ServerConnectionCard server={server} {...defaultProps} />);

      expect(screen.getByText("Finishing setup...")).toBeInTheDocument();
    });

    it("shows oauth browser authorization state", () => {
      const server = createServer({
        connectionStatus: "oauth-flow",
        useOAuth: true,
      });
      render(<ServerConnectionCard server={server} {...defaultProps} />);

      expect(screen.getByText("Authorizing in browser...")).toBeInTheDocument();
      expect(
        screen.getByText(
          "Complete sign-in in the browser. Inspector will resume automatically."
        )
      ).toBeInTheDocument();
    });

    it("shows failed status with retry count", () => {
      const server = createServer({
        connectionStatus: "failed",
        retryCount: 3,
        lastError: "Connection refused",
      });
      render(<ServerConnectionCard server={server} {...defaultProps} />);

      expect(screen.getByText("Failed (3)")).toBeInTheDocument();
    });

    it("shows a connection settings indicator without reconnect badge copy", () => {
      const server = createServer({ connectionStatus: "connected" });
      render(
        <ServerConnectionCard
          server={server}
          {...defaultProps}
          needsReconnect
        />
      );

      expect(screen.queryByText("Needs reconnect")).not.toBeInTheDocument();
      expect(
        screen.queryByLabelText("Reconnect needed")
      ).not.toBeInTheDocument();
      expect(
        screen.getByLabelText("Connection settings changed")
      ).toBeInTheDocument();
    });

    it("does not show the connection settings indicator when settings match", () => {
      const server = createServer({ connectionStatus: "connected" });
      render(<ServerConnectionCard server={server} {...defaultProps} />);

      expect(
        screen.queryByLabelText("Connection settings changed")
      ).not.toBeInTheDocument();
    });
  });

  describe("toggle switch", () => {
    it("switch is checked when server is connected", () => {
      const server = createServer({ connectionStatus: "connected" });
      render(<ServerConnectionCard server={server} {...defaultProps} />);

      const toggle = screen.getByRole("switch");
      expect(toggle).toBeChecked();
    });

    it("switch is unchecked when server is disconnected", () => {
      const server = createServer({ connectionStatus: "disconnected" });
      render(<ServerConnectionCard server={server} {...defaultProps} />);

      const toggle = screen.getByRole("switch");
      expect(toggle).not.toBeChecked();
    });

    it("calls onDisconnect when toggling off", () => {
      const server = createServer({ connectionStatus: "connected" });
      const onDisconnect = vi.fn();
      render(
        <ServerConnectionCard
          server={server}
          {...defaultProps}
          onDisconnect={onDisconnect}
        />
      );

      const toggle = screen.getByRole("switch");
      fireEvent.click(toggle);

      expect(onDisconnect).toHaveBeenCalledWith("test-server");
    });

    it("calls onReconnect when toggling on", () => {
      const server = createServer({ connectionStatus: "disconnected" });
      const onReconnect = vi.fn().mockResolvedValue(undefined);
      render(
        <ServerConnectionCard
          server={server}
          {...defaultProps}
          onReconnect={onReconnect}
        />
      );

      const toggle = screen.getByRole("switch");
      fireEvent.click(toggle);

      expect(onReconnect).toHaveBeenCalledWith("test-server", {
        allowInteractiveOAuthFlow: false,
      });
    });

    it("allows interactive OAuth fallback when toggling on an OAuth server without tokens", () => {
      const server = createServer({
        connectionStatus: "disconnected",
        useOAuth: true,
        config: { url: "https://example.com/mcp" } as any,
      });
      const onReconnect = vi.fn().mockResolvedValue(undefined);
      render(
        <ServerConnectionCard
          server={server}
          {...defaultProps}
          onReconnect={onReconnect}
        />
      );

      fireEvent.click(screen.getByRole("switch"));

      expect(onReconnect).toHaveBeenCalledWith("test-server", {
        allowInteractiveOAuthFlow: true,
      });
    });

    it("catches rejected reconnect promises and clears reconnect loading state", async () => {
      const server = createServer({ connectionStatus: "disconnected" });
      const onReconnect = vi.fn().mockImplementation(
        () =>
          new Promise<void>((_resolve, reject) => {
            setTimeout(() => reject(new Error("reconnect failed")), 20);
          })
      );

      render(
        <ServerConnectionCard
          server={server}
          {...defaultProps}
          onReconnect={onReconnect}
        />
      );

      const toggle = screen.getByRole("switch");
      fireEvent.click(toggle);

      await waitFor(() => {
        expect((toast.error as Mock).mock.calls.length).toBeGreaterThan(0);
      });
      expect(toggle).not.toBeDisabled();
    });
  });

  describe("error display", () => {
    it("shows error message when connection failed", () => {
      const server = createServer({
        connectionStatus: "failed",
        lastError: "Connection refused",
      });
      render(<ServerConnectionCard server={server} {...defaultProps} />);

      expect(screen.getByText("Connection refused")).toBeInTheDocument();
    });

    it("renders long error messages via the ErrorCard", () => {
      // The ErrorCard owns details disclosure; we just confirm the rich
      // surface shows up (title + Learn more link) rather than the old
      // ad-hoc truncation. The full message lives in the collapsed
      // details panel.
      const longError = "A".repeat(150);
      const server = createServer({
        connectionStatus: "failed",
        lastError: longError,
      });
      render(<ServerConnectionCard server={server} {...defaultProps} />);

      expect(screen.getByText("Learn more")).toBeInTheDocument();
    });

    it("shows troubleshooting link when connection failed", () => {
      const server = createServer({
        connectionStatus: "failed",
        lastError: "Error",
      });
      render(<ServerConnectionCard server={server} {...defaultProps} />);

      expect(screen.getByText("Having trouble?")).toBeInTheDocument();
      expect(screen.getByText("Check troubleshooting")).toBeInTheDocument();
    });
  });

  describe("copy functionality", () => {
    it("copies command to clipboard when copy button is clicked", async () => {
      const server = createServer({
        config: {
          command: "node",
          args: ["server.js"],
        },
      });
      render(<ServerConnectionCard server={server} {...defaultProps} />);

      fireEvent.click(
        screen.getByRole("button", { name: "Copy server command" })
      );

      await waitFor(() => {
        expect(mockClipboard.writeText).toHaveBeenCalledWith("node server.js");
      });
    });

    it("does not open the actions menu when right-clicking the copy button", () => {
      render(
        <ServerConnectionCard server={createServer()} {...defaultProps} />
      );

      fireEvent.contextMenu(
        screen.getByRole("button", { name: "Copy server command" })
      );

      expect(screen.queryByText("Configure")).not.toBeInTheDocument();
    });
  });

  describe("server info", () => {
    it("shows server version when available", () => {
      const server = createServer({
        initializationInfo: {
          serverVersion: {
            name: "test-server",
            version: "1.0.0",
            title: "Test Server",
          },
          protocolVersion: "2024-11-05",
        },
      });
      render(<ServerConnectionCard server={server} {...defaultProps} />);

      expect(screen.getByText("v1.0.0")).toBeInTheDocument();
    });

    it("does not show view server info pill (replaced by card click)", () => {
      const server = createServer({
        initializationInfo: {
          serverCapabilities: { tools: {} },
          protocolVersion: "2024-11-05",
        },
      });
      render(<ServerConnectionCard server={server} {...defaultProps} />);

      expect(screen.queryByText("View server info")).not.toBeInTheDocument();
    });

    it("requests the shared modal when the card is clicked", () => {
      const server = createServer({
        initializationInfo: {
          serverCapabilities: { tools: {} },
          protocolVersion: "2024-11-05",
        },
      });
      const onOpenDetailModal = vi.fn();

      const { container } = render(
        <ServerConnectionCard
          server={server}
          {...defaultProps}
          onOpenDetailModal={onOpenDetailModal}
        />
      );

      const card = container.querySelector("[data-slot='card']");
      fireEvent.click(card!);
      expect(onOpenDetailModal).toHaveBeenCalledWith(
        expect.objectContaining({ name: "test-server" }),
        "configuration"
      );
    });
  });

  describe("tunnel URL", () => {
    it("shows copy url tunnel pill when connected with tunnel", () => {
      const server = createServer({ connectionStatus: "connected" });
      render(
        <ServerConnectionCard
          server={server}
          {...defaultProps}
          serverTunnelUrl="https://tunnel.example.com"
        />
      );

      expect(screen.getByText("Copy tunnel URL")).toBeInTheDocument();
    });

    it("does not show copy url tunnel pill when disconnected", () => {
      const server = createServer({ connectionStatus: "disconnected" });
      render(
        <ServerConnectionCard
          server={server}
          {...defaultProps}
          serverTunnelUrl="https://tunnel.example.com"
        />
      );

      expect(screen.queryByText("Copy tunnel URL")).not.toBeInTheDocument();
    });
  });

  describe("tunnel rotate", () => {
    const seedUrl =
      "https://old000000001.tunnels.mcpjam.com/api/mcp/adapter-http/test-server?k=old";

    it("calls rotate and surfaces success", async () => {
      const { rotateServerTunnel, getServerTunnel } = await import(
        "@/lib/apis/mcp-tunnels-api"
      );
      // Keep the mount effect from clearing the prop-seeded URL.
      (getServerTunnel as Mock).mockResolvedValue({
        url: seedUrl,
        serverId: "test-server",
      });

      render(
        <ServerConnectionCard
          server={createServer({ connectionStatus: "connected" })}
          {...defaultProps}
          serverTunnelUrl={seedUrl}
        />
      );

      fireEvent.click(
        screen.getByRole("button", {
          name: "Rotate tunnel secret (revokes the current URL)",
        })
      );

      await waitFor(() => {
        expect(rotateServerTunnel).toHaveBeenCalledWith(
          "test-server",
          "test-token"
        );
      });
      await waitFor(() => {
        expect(toast.success as Mock).toHaveBeenCalledWith(
          "Tunnel secret rotated — the old URL no longer works"
        );
      });
    });

    it("re-syncs the URL from the server when a rotation fails", async () => {
      const { rotateServerTunnel, getServerTunnel } = await import(
        "@/lib/apis/mcp-tunnels-api"
      );
      (rotateServerTunnel as Mock).mockRejectedValueOnce(
        new Error("listener died")
      );
      // The mount hydration returns the live tunnel; the post-failure
      // re-sync then finds the listener already gone (null).
      (getServerTunnel as Mock)
        .mockResolvedValueOnce({ url: seedUrl, serverId: "test-server" })
        .mockResolvedValue(null);

      render(
        <ServerConnectionCard
          server={createServer({ connectionStatus: "connected" })}
          {...defaultProps}
          serverTunnelUrl={seedUrl}
        />
      );

      fireEvent.click(
        screen.getByRole("button", {
          name: "Rotate tunnel secret (revokes the current URL)",
        })
      );

      await waitFor(() => {
        expect(toast.error as Mock).toHaveBeenCalled();
      });
      // The stale, copyable URL is dropped — the create pill is shown instead.
      await waitFor(() => {
        expect(screen.queryByText("Copy tunnel URL")).not.toBeInTheDocument();
      });
    });

    it("disables copying the URL while a rotation is in flight (old URL is already revoked)", async () => {
      const { rotateServerTunnel, getServerTunnel } = await import(
        "@/lib/apis/mcp-tunnels-api"
      );
      (getServerTunnel as Mock).mockResolvedValue({
        url: seedUrl,
        serverId: "test-server",
      });
      const rotatedUrl =
        "https://old000000001.tunnels.mcpjam.com/api/mcp/adapter-http/test-server?k=new";
      let resolveRotate:
        | ((value: { url: string; serverId: string }) => void)
        | undefined;
      (rotateServerTunnel as Mock).mockImplementationOnce(
        () =>
          new Promise<{ url: string; serverId: string }>(
            (resolve) => (resolveRotate = resolve)
          )
      );

      render(
        <ServerConnectionCard
          server={createServer({ connectionStatus: "connected" })}
          {...defaultProps}
          serverTunnelUrl={seedUrl}
        />
      );

      const copyBtn = screen
        .getByText("Copy tunnel URL")
        .closest("button") as HTMLButtonElement;
      fireEvent.click(
        screen.getByRole("button", {
          name: "Rotate tunnel secret (revokes the current URL)",
        })
      );

      // The backend revokes the old grant as soon as rotation starts, so the
      // stale URL must not be copyable mid-rotate.
      await waitFor(() => expect(copyBtn).toBeDisabled());
      fireEvent.click(copyBtn);
      expect(mockClipboard.writeText).not.toHaveBeenCalled();

      resolveRotate?.({ url: rotatedUrl, serverId: "test-server" });
      await waitFor(() => expect(copyBtn).not.toBeDisabled());
      fireEvent.click(copyBtn);
      expect(mockClipboard.writeText).toHaveBeenCalledWith(rotatedUrl);
    });

    it("disables rotate while a close is in flight (mutually exclusive)", async () => {
      const { rotateServerTunnel, closeServerTunnel, getServerTunnel } =
        await import("@/lib/apis/mcp-tunnels-api");
      (getServerTunnel as Mock).mockResolvedValue({
        url: seedUrl,
        serverId: "test-server",
      });
      let resolveClose: (() => void) | undefined;
      (closeServerTunnel as Mock).mockImplementationOnce(
        () => new Promise<void>((resolve) => (resolveClose = resolve))
      );

      render(
        <ServerConnectionCard
          server={createServer({ connectionStatus: "connected" })}
          {...defaultProps}
          serverTunnelUrl={seedUrl}
        />
      );

      const rotateBtn = screen.getByRole("button", {
        name: "Rotate tunnel secret (revokes the current URL)",
      });
      fireEvent.click(screen.getByRole("button", { name: "Close tunnel" }));

      // Once the close is in flight the rotate control is disabled, so the
      // two lifecycle mutations can't run concurrently.
      await waitFor(() => expect(rotateBtn).toBeDisabled());
      fireEvent.click(rotateBtn);
      expect(rotateServerTunnel).not.toHaveBeenCalled();

      resolveClose?.();
      await waitFor(() => {
        expect(closeServerTunnel).toHaveBeenCalledTimes(1);
      });
    });
  });

  describe("tunnel revalidation", () => {
    const seedUrl =
      "https://r00000000001.tunnels.mcpjam.com/api/mcp/adapter-http/test-server?k=s";

    it("clears the displayed URL once the server reports the tunnel ended", async () => {
      vi.useFakeTimers();
      try {
        const { getServerTunnel } = await import("@/lib/apis/mcp-tunnels-api");
        // Mount sees a live tunnel; the relay then ends it server-side
        // (e.g. taken over by another inspector), so revalidation gets null.
        // Stateful (not call-ordered) so StrictMode's double-mount fetch
        // can't consume the "alive" answer early.
        let tunnelAlive = true;
        (getServerTunnel as Mock).mockImplementation(async () =>
          tunnelAlive ? { url: seedUrl, serverId: "test-server" } : null
        );

        render(
          <ServerConnectionCard
            server={createServer({ connectionStatus: "connected" })}
            {...defaultProps}
          />
        );

        await act(async () => {
          await vi.advanceTimersByTimeAsync(0);
        });
        expect(screen.getByText("Copy tunnel URL")).toBeInTheDocument();

        tunnelAlive = false;
        await act(async () => {
          await vi.advanceTimersByTimeAsync(5000);
        });
        // Dead URL is no longer copyable; the user is told why it vanished.
        expect(screen.queryByText("Copy tunnel URL")).not.toBeInTheDocument();
        expect(toast.warning as Mock).toHaveBeenCalledWith(
          expect.stringContaining("Tunnel for test-server ended")
        );
      } finally {
        vi.useRealTimers();
      }
    });

    it("suspends revalidation while a rotate is in flight (server briefly has no entry)", async () => {
      vi.useFakeTimers();
      try {
        const { getServerTunnel, rotateServerTunnel } = await import(
          "@/lib/apis/mcp-tunnels-api"
        );
        // Server-side view during rotation: the entry disappears between
        // close and re-create, so a poll then would read null.
        let tunnelVisible = true;
        (getServerTunnel as Mock).mockImplementation(async () =>
          tunnelVisible ? { url: seedUrl, serverId: "test-server" } : null
        );
        let finishRotate: (() => void) | undefined;
        (rotateServerTunnel as Mock).mockImplementationOnce(
          () =>
            new Promise((resolve) => {
              finishRotate = () =>
                resolve({
                  url: seedUrl.replace("?k=s", "?k=s2"),
                  serverId: "test-server",
                });
            })
        );

        render(
          <ServerConnectionCard
            server={createServer({ connectionStatus: "connected" })}
            {...defaultProps}
          />
        );
        await act(async () => {
          await vi.advanceTimersByTimeAsync(0);
        });
        expect(screen.getByText("Copy tunnel URL")).toBeInTheDocument();
        const callsAfterMount = (getServerTunnel as Mock).mock.calls.length;

        // Start a rotate that hangs; the server-side entry vanishes. The
        // awaited act flushes setIsRotatingTunnel(true) so the revalidation
        // effect re-runs and tears down the poll before timers advance.
        await act(async () => {
          fireEvent.click(
            screen.getByRole("button", {
              name: "Rotate tunnel secret (revokes the current URL)",
            })
          );
        });
        tunnelVisible = false;
        await act(async () => {
          await vi.advanceTimersByTimeAsync(15000);
        });
        // Poll suspended: no extra getServerTunnel calls, URL kept, no toast.
        expect((getServerTunnel as Mock).mock.calls.length).toBe(
          callsAfterMount
        );
        expect(screen.getByText("Copy tunnel URL")).toBeInTheDocument();
        expect(toast.warning as Mock).not.toHaveBeenCalled();

        // Rotation completes; the URL is still shown.
        tunnelVisible = true;
        await act(async () => {
          finishRotate?.();
          await vi.advanceTimersByTimeAsync(0);
        });
        expect(screen.getByText("Copy tunnel URL")).toBeInTheDocument();
      } finally {
        vi.useRealTimers();
      }
    });

    it("detects a tunnel that died during creation without waiting a full poll interval", async () => {
      vi.useFakeTimers();
      try {
        const { getServerTunnel, createServerTunnel } = await import(
          "@/lib/apis/mcp-tunnels-api"
        );
        // The create endpoint answers with the grant URL even when a
        // permanent relay close raced the handshake (by design — see the
        // create route); the server then holds no live entry.
        (getServerTunnel as Mock).mockResolvedValue(null);
        (createServerTunnel as Mock).mockResolvedValue({
          url: seedUrl,
          serverId: "test-server",
        });
        localStorage.setItem(TUNNEL_EXPLANATION_DISMISSED_KEY, "true");

        render(
          <ServerConnectionCard
            server={createServer({ connectionStatus: "connected" })}
            {...defaultProps}
          />
        );
        await act(async () => {
          await vi.advanceTimersByTimeAsync(0);
        });

        await act(async () => {
          fireEvent.click(
            screen.getByRole("button", { name: "Create tunnel" })
          );
        });
        // Far less than the 5s poll cadence: the effect's immediate
        // revalidation must catch the dead tunnel, not the first tick.
        await act(async () => {
          await vi.advanceTimersByTimeAsync(50);
        });

        expect(screen.queryByText("Copy tunnel URL")).not.toBeInTheDocument();
        expect(toast.warning as Mock).toHaveBeenCalledWith(
          expect.stringContaining("Tunnel for test-server ended")
        );
      } finally {
        localStorage.removeItem(TUNNEL_EXPLANATION_DISMISSED_KEY);
        vi.useRealTimers();
      }
    });

    it("keeps the URL on transient revalidation errors", async () => {
      vi.useFakeTimers();
      try {
        const { getServerTunnel } = await import("@/lib/apis/mcp-tunnels-api");
        let failing = false;
        (getServerTunnel as Mock).mockImplementation(async () => {
          if (failing) throw new Error("network blip");
          return { url: seedUrl, serverId: "test-server" };
        });

        render(
          <ServerConnectionCard
            server={createServer({ connectionStatus: "connected" })}
            {...defaultProps}
          />
        );

        await act(async () => {
          await vi.advanceTimersByTimeAsync(0);
        });
        failing = true;
        await act(async () => {
          await vi.advanceTimersByTimeAsync(5000);
        });
        expect(screen.getByText("Copy tunnel URL")).toBeInTheDocument();
        expect(toast.warning as Mock).not.toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe("tunnel recent-requests panel", () => {
    const seedUrl =
      "https://t00000000001.tunnels.mcpjam.com/api/mcp/adapter-http/test-server?k=s";

    it("polls and renders recent requests when opened", async () => {
      const { getServerTunnel, getTunnelRequests } = await import(
        "@/lib/apis/mcp-tunnels-api"
      );
      (getServerTunnel as Mock).mockResolvedValue({
        url: seedUrl,
        serverId: "test-server",
      });
      (getTunnelRequests as Mock).mockResolvedValue([
        { ts: 1_700_000_000_000, method: "tools/list", path: "/api/x" },
      ]);

      render(
        <ServerConnectionCard
          server={createServer({ connectionStatus: "connected" })}
          {...defaultProps}
          serverTunnelUrl={seedUrl}
        />
      );

      fireEvent.click(
        screen.getByRole("button", { name: "Recent tunnel requests" })
      );

      await waitFor(() => {
        expect(getTunnelRequests).toHaveBeenCalledWith(
          "test-server",
          "test-token"
        );
      });
      expect(await screen.findByText("tools/list")).toBeInTheDocument();
    });

    it("keeps the last snapshot when a poll fails", async () => {
      const { getServerTunnel, getTunnelRequests } = await import(
        "@/lib/apis/mcp-tunnels-api"
      );
      (getServerTunnel as Mock).mockResolvedValue({
        url: seedUrl,
        serverId: "test-server",
      });
      (getTunnelRequests as Mock)
        .mockResolvedValueOnce([
          { ts: 1_700_000_000_000, method: "initialize", path: "/api/x" },
        ])
        .mockRejectedValue(new Error("boom"));

      render(
        <ServerConnectionCard
          server={createServer({ connectionStatus: "connected" })}
          {...defaultProps}
          serverTunnelUrl={seedUrl}
        />
      );

      const panelToggle = screen.getByRole("button", {
        name: "Recent tunnel requests",
      });

      // First fetch renders the snapshot.
      fireEvent.click(panelToggle);
      expect(await screen.findByText("initialize")).toBeInTheDocument();

      // Re-opening the panel re-runs the polling effect immediately, which
      // deterministically fires the rejecting second fetch (no need to wait
      // out the 4s interval).
      fireEvent.click(panelToggle);
      fireEvent.click(panelToggle);
      await waitFor(() => {
        expect(getTunnelRequests).toHaveBeenCalledTimes(2);
      });

      // The rejected poll must not clear the retained snapshot or crash.
      expect(await screen.findByText("initialize")).toBeInTheDocument();
    });
  });
});
