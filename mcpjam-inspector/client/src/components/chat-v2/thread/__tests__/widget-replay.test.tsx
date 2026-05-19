import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { MCP_UI_EXTENSION_ID } from "@mcpjam/sdk/browser";
import { WidgetReplay } from "../widget-replay";
import { ActiveHostClientCapabilitiesProvider } from "@/contexts/active-host-client-capabilities-context";

const mockDetectUIType = vi.fn();

// After the renderer consolidation (Phase 3), every UI-bearing tool —
// Apps SDK, MCP Apps, or dual-metadata — routes through MCPAppsRenderer.
// The previous chatgpt-vs-mcp branching by chatbox style is gone.

vi.mock("../mcp-apps/mcp-apps-renderer", () => ({
  MCPAppsRenderer: ({ toolName }: { toolName: string }) => (
    <div data-testid="mcp-apps-renderer">{toolName}</div>
  ),
}));

vi.mock("@/lib/mcp-ui/mcp-apps-utils", () => ({
  detectUIType: (...args: unknown[]) => mockDetectUIType(...args),
  getUIResourceUri: () => "ui://widget/test.html",
  UIType: {
    MCP_APPS: "mcp-apps",
    OPENAI_SDK: "openai-sdk",
    OPENAI_SDK_AND_MCP_APPS: "openai-sdk-and-mcp-apps",
    MCP_UI: "mcp-ui",
  },
}));

vi.mock("@/lib/apis/mcp-tools-api", () => ({
  getToolServerId: () => "server-1",
}));

vi.mock("@/lib/tool-result-utils", () => ({
  readToolResultMeta: () => undefined,
  readToolResultServerId: () => "server-1",
}));

describe("WidgetReplay", () => {
  const baseProps = {
    toolName: "dual-tool",
    toolCallId: "call-1",
    toolState: "output-available" as const,
    toolInput: { prompt: "hello" },
    toolOutput: { ok: true },
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("routes Apps-SDK-only widgets through MCPAppsRenderer", () => {
    mockDetectUIType.mockReturnValue("openai-sdk");
    render(<WidgetReplay {...baseProps} />);
    expect(screen.getByTestId("mcp-apps-renderer")).toBeInTheDocument();
  });

  it("routes MCP-Apps-only widgets through MCPAppsRenderer", () => {
    mockDetectUIType.mockReturnValue("mcp-apps");
    render(<WidgetReplay {...baseProps} />);
    expect(screen.getByTestId("mcp-apps-renderer")).toBeInTheDocument();
  });

  it("routes dual-metadata widgets through MCPAppsRenderer", () => {
    mockDetectUIType.mockReturnValue("openai-sdk-and-mcp-apps");
    render(<WidgetReplay {...baseProps} />);
    expect(screen.getByTestId("mcp-apps-renderer")).toBeInTheDocument();
  });

  it("renders nothing when detectUIType returns null", () => {
    mockDetectUIType.mockReturnValue(null);
    const { container } = render(<WidgetReplay {...baseProps} />);
    expect(container.firstChild).toBeNull();
  });

  describe("host capability gate (Bug 1)", () => {
    it("renders when the host advertises the MCP UI extension", () => {
      mockDetectUIType.mockReturnValue("mcp-apps");
      const caps = {
        extensions: {
          [MCP_UI_EXTENSION_ID]: {
            mimeTypes: ["text/html;profile=mcp-app"],
          },
        },
      };
      render(
        <ActiveHostClientCapabilitiesProvider value={caps}>
          <WidgetReplay {...baseProps} />
        </ActiveHostClientCapabilitiesProvider>
      );
      expect(screen.getByTestId("mcp-apps-renderer")).toBeInTheDocument();
    });

    it("renders nothing when the host strips the UI extension (Codex)", () => {
      mockDetectUIType.mockReturnValue("mcp-apps");
      const codexCaps = { elicitation: {} };
      const { container } = render(
        <ActiveHostClientCapabilitiesProvider value={codexCaps}>
          <WidgetReplay {...baseProps} />
        </ActiveHostClientCapabilitiesProvider>
      );
      expect(container.firstChild).toBeNull();
    });
  });
});
