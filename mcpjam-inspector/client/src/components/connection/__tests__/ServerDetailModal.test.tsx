import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ServerWithName } from "@/hooks/use-app-state";
import type { ListToolsResultWithMetadata } from "@/lib/apis/mcp-tools-api";

const mockCapture = vi.fn();

vi.mock("posthog-js/react", () => ({
  usePostHog: () => ({
    capture: mockCapture,
  }),
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
        meta["ui.resourceUri"]) as unknown,
    );

  return {
    isMCPApp: (toolsData: { toolsMetadata?: Record<string, unknown> } | null) =>
      Object.values(toolsData?.toolsMetadata ?? {}).some((meta) =>
        hasUiResourceUri((meta ?? {}) as Record<string, unknown>),
      ),
    isOpenAIApp: (
      toolsData: {
        toolsMetadata?: Record<string, unknown>;
      } | null,
    ) =>
      Object.values(toolsData?.toolsMetadata ?? {}).some((meta) =>
        Boolean(
          (meta as Record<string, unknown>)?.["openai/outputTemplate"] &&
          !hasUiResourceUri((meta ?? {}) as Record<string, unknown>),
        ),
      ),
    isOpenAIAppAndMCPApp: (
      toolsData: {
        toolsMetadata?: Record<string, unknown>;
      } | null,
    ) =>
      Object.values(toolsData?.toolsMetadata ?? {}).some((meta) =>
        Boolean(
          (meta as Record<string, unknown>)?.["openai/outputTemplate"] &&
          hasUiResourceUri((meta ?? {}) as Record<string, unknown>),
        ),
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

describe("ServerDetailModal", () => {
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
    localStorage.clear();
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
      <ServerDetailModal {...defaultProps} defaultTab="overview" />,
    );

    const overviewPanel = document.querySelector(
      '[role="tabpanel"][data-state="active"]',
    );
    expect(overviewPanel).toBeInTheDocument();
    expect(overviewPanel?.className).toContain("overflow-y-auto");
    unmount();

    // Tools Metadata tab also uses overflow-y-auto
    // In real usage the modal remounts via key prop, so we render fresh
    render(<ServerDetailModal {...defaultProps} defaultTab="tools-metadata" />);

    await waitFor(() => {
      const toolsPanel = document.querySelector(
        '[role="tabpanel"][data-state="active"]',
      );
      expect(toolsPanel).toBeInTheDocument();
      expect(toolsPanel?.className).toContain("overflow-y-auto");
    });
    expect(screen.getByText("search")).toBeInTheDocument();
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
      screen.queryByText("Connect to view tools metadata"),
    ).not.toBeInTheDocument();
    expect(screen.getByText("Search tool")).toBeInTheDocument();
  });

  it("shows a connect prompt in overview when the server is disconnected", () => {
    render(
      <ServerDetailModal
        {...defaultProps}
        server={createServer({ connectionStatus: "disconnected" })}
        defaultTab="overview"
      />,
    );

    expect(
      screen.getByText("Connect to view server overview"),
    ).toBeInTheDocument();
  });

  it("uses the non-interactive reconnect path when toggling on from the detail modal", () => {
    const onReconnect = vi.fn().mockResolvedValue(undefined);
    render(
      <ServerDetailModal
        {...defaultProps}
        server={createServer({ connectionStatus: "disconnected" })}
        onReconnect={onReconnect}
      />,
    );

    fireEvent.click(screen.getByRole("switch"));

    expect(onReconnect).toHaveBeenCalledWith("test-server", {
      allowInteractiveOAuthFlow: false,
    });
  });

  it("forces a fresh OAuth flow when toggling on an OAuth server without tokens", () => {
    const onReconnect = vi.fn().mockResolvedValue(undefined);
    render(
      <ServerDetailModal
        {...defaultProps}
        server={createServer({
          connectionStatus: "disconnected",
          useOAuth: true,
        })}
        onReconnect={onReconnect}
      />,
    );

    fireEvent.click(screen.getByRole("switch"));

    expect(onReconnect).toHaveBeenCalledWith("test-server", {
      forceOAuthFlow: true,
    });
  });

  it("does not show a conformance launch button in overview", () => {
    render(<ServerDetailModal {...defaultProps} defaultTab="overview" />);

    expect(
      screen.queryByRole("button", { name: "Run conformance" }),
    ).not.toBeInTheDocument();
  });

  it("submits the configuration form without closing the modal", async () => {
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
      />,
    );

    const form = screen
      .getByRole("button", { name: "Save Changes" })
      .closest("form");

    expect(form).not.toBeNull();
    fireEvent.submit(form!);

    await waitFor(() => {
      expect(onSubmit).toHaveBeenCalledWith(
        expect.objectContaining({ name: "test-server" }),
        "test-server",
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
      />,
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
      />,
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
      />,
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
        "Saved auth data is invalid. Reconnect this server to refresh tokens.",
      ),
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
        }),
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
        screen.getByRole("button", { name: "Save Changes" }),
      ).toBeEnabled();
    });
  });

  it("stops Enter from bubbling out of the modal", () => {
    const onKeyDown = vi.fn();

    render(
      <div onKeyDown={onKeyDown}>
        <ServerDetailModal {...defaultProps} />
      </div>,
    );

    fireEvent.keyDown(screen.getByDisplayValue("test-server"), {
      key: "Enter",
    });

    expect(onKeyDown).not.toHaveBeenCalled();
  });
});
