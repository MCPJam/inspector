import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ServerWithName } from "@/hooks/use-app-state";
import type { ListToolsResultWithMetadata } from "@/lib/apis/mcp-tools-api";

const mockCapture = vi.fn();
const mockUseFeatureFlagEnabled = vi.hoisted(() => vi.fn(() => false));
const mockUseQuery = vi.hoisted(() => vi.fn(() => undefined));
const mockSetProjectServerConfig = vi.hoisted(() => vi.fn());

vi.mock("@workos-inc/authkit-react", () => ({
  useAuth: () => ({ user: { email: "tester@example.com" } }),
}));

vi.mock("posthog-js/react", () => ({
  usePostHog: () => ({
    capture: mockCapture,
  }),
  // ServerDetailModal calls `useFeatureFlagEnabled("stateless-mcp-enabled")`
  // to gate the per-server protocol-version dropdown. Default `false` here
  // so the existing test setup exercises the pre-flag UI shape; tests that
  // need the dropdown enabled should override per-test via
  // `vi.mocked(useFeatureFlagEnabled).mockReturnValue(true)`.
  useFeatureFlagEnabled: (...args: unknown[]) =>
    mockUseFeatureFlagEnabled(...args),
}));

// ServerDetailModal reads + writes the project-server config via Convex
// (`useQuery("projectServerConfig:getConfig")` + `useMutation` for save).
// The tests don't exercise that round-trip; stub both to no-ops so the
// component mounts. `useQuery` returns `undefined` (matches the
// pre-loaded Convex state); `useMutation` returns a no-op function.
vi.mock("convex/react", () => ({
  useQuery: (...args: unknown[]) => mockUseQuery(...args),
  useMutation: () => mockSetProjectServerConfig,
}));

vi.mock("sonner", () => ({
  toast: {
    error: vi.fn(),
  },
}));

const mockListTools = vi.fn().mockResolvedValue({
  tools: [],
  toolsMetadata: {},
});

vi.mock("@/lib/apis/mcp-tools-api", () => ({
  listTools: (...args: unknown[]) => mockListTools(...args),
}));

vi.mock("@/lib/mcp-ui/mcp-apps-utils", () => {
  const hasUiResourceUri = (meta: Record<string, unknown>) =>
    Boolean(
      ((meta["ui"] as { resourceUri?: unknown } | undefined)?.resourceUri ??
        meta["ui.resourceUri"]) as unknown
    );

  return {
    isMCPApp: (toolsData: { toolsMetadata?: Record<string, unknown> } | null) =>
      Object.values(toolsData?.toolsMetadata ?? {}).some((meta) =>
        hasUiResourceUri((meta ?? {}) as Record<string, unknown>)
      ),
    isOpenAIApp: (
      toolsData: {
        toolsMetadata?: Record<string, unknown>;
      } | null
    ) =>
      Object.values(toolsData?.toolsMetadata ?? {}).some((meta) =>
        Boolean(
          (meta as Record<string, unknown>)?.["openai/outputTemplate"] &&
            !hasUiResourceUri((meta ?? {}) as Record<string, unknown>)
        )
      ),
    isOpenAIAppAndMCPApp: (
      toolsData: {
        toolsMetadata?: Record<string, unknown>;
      } | null
    ) =>
      Object.values(toolsData?.toolsMetadata ?? {}).some((meta) =>
        Boolean(
          (meta as Record<string, unknown>)?.["openai/outputTemplate"] &&
            hasUiResourceUri((meta ?? {}) as Record<string, unknown>)
        )
      ),
    UIType: {
      MCP_APPS: "mcp-apps",
      OPENAI_SDK: "openai-sdk",
      OPENAI_SDK_AND_MCP_APPS: "openai-sdk-and-mcp-apps",
      MCP_UI: "mcp-ui",
    },
  };
});

import { ServerDetailModal } from "../ServerDetailModal";

const installPointerCaptureMocks = () => {
  Object.defineProperty(HTMLElement.prototype, "hasPointerCapture", {
    configurable: true,
    value: vi.fn(() => false),
  });
  Object.defineProperty(HTMLElement.prototype, "setPointerCapture", {
    configurable: true,
    value: vi.fn(),
  });
  Object.defineProperty(HTMLElement.prototype, "releasePointerCapture", {
    configurable: true,
    value: vi.fn(),
  });
};

const getProtocolVersionCombobox = () => {
  const comboboxes = screen.getAllByRole("combobox");
  return comboboxes[comboboxes.length - 1];
};

describe("ServerDetailModal", () => {
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
      url: "https://example.com/mcp",
    },
    ...overrides,
  });

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
    mockUseFeatureFlagEnabled.mockReturnValue(false);
    mockUseQuery.mockReturnValue(undefined);
    mockSetProjectServerConfig.mockResolvedValue({
      projectId: "project_123",
      serverIds: [],
      overrides: {},
    });
    localStorage.clear();
    sessionStorage.clear();
    mockListTools.mockResolvedValue({
      tools: [],
      toolsMetadata: {},
    });
  });

  it("keeps the footer in the DOM but visually hidden when not on configuration tab", () => {
    render(<ServerDetailModal {...defaultProps} defaultTab="overview" />);

    const footer = screen.getByTestId("modal-footer");
    expect(footer).toBeInTheDocument();
    expect(footer.style.visibility).toBe("hidden");
  });

  it("uses overflow-y-auto for non-configuration tabs", async () => {
    const toolsData = {
      tools: [
        {
          name: "search",
          description: "Searches documents",
          _meta: { write: false, "ui.resourceUri": "ui://widget/search" },
        },
      ],
      toolsMetadata: {
        search: {
          "ui.resourceUri": "ui://widget/search",
        },
      },
    } as unknown as ListToolsResultWithMetadata;
    mockListTools.mockResolvedValue(toolsData);

    // Overview tab uses overflow-y-auto for scrolling
    const { unmount } = render(
      <ServerDetailModal {...defaultProps} defaultTab="overview" />
    );

    const overviewPanel = document.querySelector(
      '[role="tabpanel"][data-state="active"]'
    );
    expect(overviewPanel).toBeInTheDocument();
    expect(overviewPanel?.className).toContain("overflow-y-auto");
    unmount();

    // Tools Metadata tab also uses overflow-y-auto
    // In real usage the modal remounts via key prop, so we render fresh
    render(<ServerDetailModal {...defaultProps} defaultTab="tools-metadata" />);

    await waitFor(() => {
      const toolsPanel = document.querySelector(
        '[role="tabpanel"][data-state="active"]'
      );
      expect(toolsPanel).toBeInTheDocument();
      expect(toolsPanel?.className).toContain("overflow-y-auto");
    });
    expect(await screen.findByText("search")).toBeInTheDocument();
  });

  it("shows tool metadata for connected non-app servers", async () => {
    mockListTools.mockResolvedValue({
      tools: [
        {
          name: "search",
          description: "Searches documents",
          _meta: { title: "Search tool", write: false },
        },
      ],
      toolsMetadata: {
        search: {
          title: "Search tool",
          write: false,
        },
      },
    });

    render(<ServerDetailModal {...defaultProps} defaultTab="tools-metadata" />);

    await waitFor(() => {
      expect(screen.getByText("search")).toBeInTheDocument();
    });
    expect(
      screen.queryByText("Connect to view tools metadata")
    ).not.toBeInTheDocument();
    expect(screen.getByText("Search tool")).toBeInTheDocument();
  });

  it("shows a connect prompt in overview when the server is disconnected", () => {
    render(
      <ServerDetailModal
        {...defaultProps}
        server={createServer({ connectionStatus: "disconnected" })}
        defaultTab="overview"
      />
    );

    expect(
      screen.getByText("Connect to view server overview")
    ).toBeInTheDocument();
  });

  it("uses the non-interactive reconnect path when toggling on from the detail modal", () => {
    const onReconnect = vi.fn().mockResolvedValue(undefined);
    render(
      <ServerDetailModal
        {...defaultProps}
        server={createServer({ connectionStatus: "disconnected" })}
        onReconnect={onReconnect}
      />
    );

    fireEvent.click(screen.getByRole("switch"));

    expect(onReconnect).toHaveBeenCalledWith("test-server", {
      allowInteractiveOAuthFlow: false,
    });
  });

  it("allows interactive OAuth fallback when toggling on an OAuth server without tokens", () => {
    const onReconnect = vi.fn().mockResolvedValue(undefined);
    render(
      <ServerDetailModal
        {...defaultProps}
        server={createServer({
          connectionStatus: "disconnected",
          useOAuth: true,
        })}
        onReconnect={onReconnect}
      />
    );

    fireEvent.click(screen.getByRole("switch"));

    expect(onReconnect).toHaveBeenCalledWith("test-server", {
      allowInteractiveOAuthFlow: true,
    });
  });

  it("allows setting a protocol override before the server is in auto-connect", async () => {
    const user = userEvent.setup();
    installPointerCaptureMocks();
    mockUseFeatureFlagEnabled.mockReturnValue(true);
    mockUseQuery.mockReturnValue({
      projectId: "project_123",
      serverIds: [],
      overrides: {},
    });

    render(
      <ServerDetailModal
        {...defaultProps}
        projectId="project_123"
        hostedServerId="server_123"
        hostDefaultMcpProtocolVersion="2026-07-28"
      />
    );

    await user.click(
      screen.getByRole("button", { name: /connection overrides/i })
    );
    const protocolSelect = getProtocolVersionCombobox();
    expect(protocolSelect).toHaveTextContent("Host default");
    expect(protocolSelect).toBeEnabled();

    await user.click(protocolSelect);
    await user.click(
      await screen.findByRole("option", { name: "Latest (2025-11-25)" })
    );

    await waitFor(() => {
      expect(mockSetProjectServerConfig).toHaveBeenCalledWith({
        projectId: "project_123",
        input: {
          serverIds: ["server_123"],
          overrides: {
            server_123: {
              mcpProtocolVersionOverride: "2025-11-25",
            },
          },
        },
      });
    });
  });

  it("removes implicit auto-connect enrollment when clearing a modal-created protocol override", async () => {
    const user = userEvent.setup();
    installPointerCaptureMocks();
    mockUseFeatureFlagEnabled.mockReturnValue(true);
    let projectServerConfig = {
      projectId: "project_123",
      serverIds: [] as string[],
      overrides: {},
    };
    mockUseQuery.mockImplementation(() => projectServerConfig);

    const renderModal = () => (
      <ServerDetailModal
        {...defaultProps}
        projectId="project_123"
        hostedServerId="server_123"
        hostDefaultMcpProtocolVersion="2026-07-28"
      />
    );
    const { unmount } = render(renderModal());

    await user.click(
      screen.getByRole("button", { name: /connection overrides/i })
    );
    const hostDefaultSelect = getProtocolVersionCombobox();
    expect(hostDefaultSelect).toHaveTextContent("Host default");

    await user.click(hostDefaultSelect);
    await user.click(
      await screen.findByRole("option", { name: "Latest (2025-11-25)" })
    );

    await waitFor(() => {
      expect(mockSetProjectServerConfig).toHaveBeenCalledWith({
        projectId: "project_123",
        input: {
          serverIds: ["server_123"],
          overrides: {
            server_123: {
              mcpProtocolVersionOverride: "2025-11-25",
            },
          },
        },
      });
    });
    await waitFor(() => {
      expect(
        screen.queryByRole("option", { name: "Latest (2025-11-25)" })
      ).not.toBeInTheDocument();
    });
    unmount();

    projectServerConfig = {
      projectId: "project_123",
      serverIds: ["server_123"],
      overrides: {
        server_123: {
          mcpProtocolVersionOverride: "2025-11-25",
        },
      },
    };
    mockSetProjectServerConfig.mockClear();
    render(renderModal());

    await user.click(
      screen.getByRole("button", { name: /connection overrides/i })
    );

    const latestSelect = getProtocolVersionCombobox();
    expect(latestSelect).toHaveTextContent("Latest (2025-11-25)");

    await user.click(latestSelect);
    await user.click(
      await screen.findByRole("option", { name: "Host default" })
    );

    await waitFor(() => {
      expect(mockSetProjectServerConfig).toHaveBeenCalledWith({
        projectId: "project_123",
        input: {
          serverIds: [],
          overrides: {},
        },
      });
    });
  });

  it("keeps explicit auto-connect enrollment when clearing a protocol override", async () => {
    const user = userEvent.setup();
    installPointerCaptureMocks();
    mockUseFeatureFlagEnabled.mockReturnValue(true);
    mockUseQuery.mockReturnValue({
      projectId: "project_123",
      serverIds: ["server_123"],
      overrides: {
        server_123: {
          mcpProtocolVersionOverride: "2025-11-25",
        },
      },
    });

    render(
      <ServerDetailModal
        {...defaultProps}
        projectId="project_123"
        hostedServerId="server_123"
        hostDefaultMcpProtocolVersion="2026-07-28"
      />
    );

    await user.click(
      screen.getByRole("button", { name: /connection overrides/i })
    );
    const protocolSelect = getProtocolVersionCombobox();
    expect(protocolSelect).toHaveTextContent("Latest (2025-11-25)");

    await user.click(protocolSelect);
    await user.click(
      await screen.findByRole("option", { name: "Host default" })
    );

    await waitFor(() => {
      expect(mockSetProjectServerConfig).toHaveBeenCalledWith({
        projectId: "project_123",
        input: {
          serverIds: ["server_123"],
          overrides: {},
        },
      });
    });
  });

  it("does not show a conformance launch button in overview", () => {
    render(<ServerDetailModal {...defaultProps} defaultTab="overview" />);

    expect(
      screen.queryByRole("button", { name: "Run conformance" })
    ).not.toBeInTheDocument();
  });

  it("renders local OAuth tokens from localStorage in overview", () => {
    localStorage.setItem(
      "mcp-tokens-test-server",
      JSON.stringify({
        access_token: "local-access-token",
        refresh_token: "local-refresh-token",
        token_type: "Bearer",
        expires_in: 3600,
        scope: "read",
      })
    );

    render(
      <ServerDetailModal
        {...defaultProps}
        server={createServer({ useOAuth: true })}
        defaultTab="overview"
      />
    );

    expect(screen.getByText("local-access-token")).toBeInTheDocument();
    expect(screen.getByText("local-refresh-token")).toBeInTheDocument();
    expect(screen.getByText("Scope: read")).toBeInTheDocument();
  });

  it("submits the configuration form without closing the modal", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn().mockResolvedValue({
      ok: true,
      serverName: "test-server",
    });
    const onClose = vi.fn();

    render(
      <ServerDetailModal
        {...defaultProps}
        onSubmit={onSubmit}
        onClose={onClose}
      />
    );

    // Edit a field so the form has changes and "Save Changes" is active
    // (connected servers with no changes show "Reconnect" instead).
    const nameInput = screen.getByDisplayValue("test-server");
    await user.clear(nameInput);
    await user.type(nameInput, "test-server-renamed");

    const form = screen
      .getByRole("button", { name: "Save Changes" })
      .closest("form");

    expect(form).not.toBeNull();
    fireEvent.submit(form!);

    await waitFor(() => {
      expect(onSubmit).toHaveBeenCalledWith(
        expect.objectContaining({ name: "test-server-renamed" }),
        "test-server"
      );
    });
    expect(onClose).not.toHaveBeenCalled();
  });

  it("pressing Enter in configuration submits without closing the modal", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn().mockResolvedValue({
      ok: true,
      serverName: "test-server",
    });
    const onClose = vi.fn();

    render(
      <ServerDetailModal
        {...defaultProps}
        onSubmit={onSubmit}
        onClose={onClose}
      />
    );

    const input = screen.getByDisplayValue("test-server");
    await user.click(input);
    await user.type(input, "-edited");
    await user.keyboard("{Enter}");

    await waitFor(() => {
      expect(onSubmit).toHaveBeenCalled();
    });
    expect(onClose).not.toHaveBeenCalled();
  });

  it("does not submit when Enter is pressed in overview", () => {
    const onSubmit = vi.fn().mockResolvedValue({
      ok: true,
      serverName: "test-server",
    });

    render(
      <ServerDetailModal
        {...defaultProps}
        defaultTab="overview"
        onSubmit={onSubmit}
      />
    );

    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Enter" });

    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("does not submit when Enter is pressed in tools metadata", async () => {
    const onSubmit = vi.fn().mockResolvedValue({
      ok: true,
      serverName: "test-server",
    });
    mockListTools.mockResolvedValue({
      tools: [
        {
          name: "search",
          description: "Searches documents",
          _meta: { write: false, "ui.resourceUri": "ui://widget/search" },
        },
      ],
      toolsMetadata: {
        search: {
          "ui.resourceUri": "ui://widget/search",
        },
      },
    });

    render(
      <ServerDetailModal
        {...defaultProps}
        defaultTab="tools-metadata"
        onSubmit={onSubmit}
      />
    );

    await waitFor(() => {
      expect(screen.getByText("search")).toBeInTheDocument();
    });

    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Enter" });

    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("shows a reconnect message instead of crashing when stored auth data is invalid", () => {
    localStorage.setItem("mcp-tokens-test-server", '{"access_token":"broken"');

    render(<ServerDetailModal {...defaultProps} defaultTab="overview" />);

    expect(
      screen.getByText(
        "Saved auth data is invalid. Reconnect this server to refresh tokens."
      )
    ).toBeInTheDocument();
  });

  it("disables the save button while an async save is pending", async () => {
    const user = userEvent.setup();
    let resolveSubmit:
      | ((value: { ok: boolean; serverName: string }) => void)
      | undefined;
    const onSubmit = vi.fn(
      () =>
        new Promise<{ ok: boolean; serverName: string }>((resolve) => {
          resolveSubmit = resolve;
        })
    );

    render(<ServerDetailModal {...defaultProps} onSubmit={onSubmit} />);

    // Make a change so the save button becomes enabled
    const input = screen.getByDisplayValue("test-server");
    await user.type(input, "-edited");

    const saveButton = screen.getByRole("button", { name: "Save Changes" });
    fireEvent.click(saveButton);

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Saving..." })).toBeDisabled();
    });

    resolveSubmit?.({ ok: true, serverName: "test-server" });
    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: "Save Changes" })
      ).toBeEnabled();
    });
  });

  it("stops Enter from bubbling out of the modal", () => {
    const onKeyDown = vi.fn();

    render(
      <div onKeyDown={onKeyDown}>
        <ServerDetailModal {...defaultProps} />
      </div>
    );

    fireEvent.keyDown(screen.getByDisplayValue("test-server"), {
      key: "Enter",
    });

    expect(onKeyDown).not.toHaveBeenCalled();
  });
});
