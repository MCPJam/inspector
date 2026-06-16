import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { WidgetReplay } from "../widget-replay";

const mockDetectUIType = vi.fn();

// After the renderer consolidation (Phase 3), every UI-bearing tool —
// Apps SDK, MCP Apps, or dual-metadata — routes through MCPAppsRenderer.
// The previous chatgpt-vs-mcp branching by chatbox style is gone.

vi.mock("../mcp-apps/mcp-apps-renderer", () => ({
  MCPAppsRenderer: ({ toolName }: { toolName: string }) => (
    <div data-testid="mcp-apps-renderer">{toolName}</div>
  ),
}));

// WidgetReplay wraps the renderer in <InspectorWidgetHostProvider> (which composes
// the host from ~14 stores/contexts). These routing tests mock the renderer to a
// stub, so the provider is a pass-through here.
vi.mock("../mcp-apps/use-widget-host", () => ({
  InspectorWidgetHostProvider: ({
    children,
  }: {
    children: import("react").ReactNode;
  }) => children,
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

  // The caps-blob → boolean integration (`hostSupportsWidgetRendering` over the
  // active host's resolved `clientCapabilities`) now lives in the injecting
  // caller (PartSwitch) and is covered by PartSwitch.test.tsx. WidgetReplay only
  // applies the injected `resolveHostSupportsWidget` gate with its own serverId.
  describe("host capability gate (injected)", () => {
    it("renders when resolveHostSupportsWidget returns true", () => {
      mockDetectUIType.mockReturnValue("mcp-apps");
      render(
        <WidgetReplay {...baseProps} resolveHostSupportsWidget={() => true} />
      );
      expect(screen.getByTestId("mcp-apps-renderer")).toBeInTheDocument();
    });

    it("renders nothing when resolveHostSupportsWidget returns false (e.g. Codex strips the UI extension)", () => {
      mockDetectUIType.mockReturnValue("mcp-apps");
      const { container } = render(
        <WidgetReplay {...baseProps} resolveHostSupportsWidget={() => false} />
      );
      expect(container.firstChild).toBeNull();
    });

    it("applies the gate with the tool's resolved serverId", () => {
      mockDetectUIType.mockReturnValue("mcp-apps");
      const resolveHostSupportsWidget = vi.fn(() => true);
      render(
        <WidgetReplay
          {...baseProps}
          resolveHostSupportsWidget={resolveHostSupportsWidget}
        />
      );
      expect(resolveHostSupportsWidget).toHaveBeenCalledWith("server-1");
    });

    it("defaults to permissive (renders) when no gate is injected", () => {
      mockDetectUIType.mockReturnValue("mcp-apps");
      render(<WidgetReplay {...baseProps} />);
      expect(screen.getByTestId("mcp-apps-renderer")).toBeInTheDocument();
    });
  });
});
