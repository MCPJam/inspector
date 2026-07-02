import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { MCP_UI_EXTENSION_ID } from "@mcpjam/sdk/browser";
import { PartSwitch } from "../thread/part-switch";
import { ActiveHostCapsResolverProvider } from "@/contexts/active-host-client-capabilities-context";
import type { UIMessage } from "@ai-sdk/react";

const { mockDetectUIType, mockWidgetReplay } = vi.hoisted(() => ({
  mockDetectUIType: vi.fn(),
  mockWidgetReplay: vi.fn(),
}));

// Mock all part components
vi.mock("../thread/parts/text-part", () => ({
  TextPart: ({ text, role }: { text: string; role: string }) => (
    <div data-testid="text-part" data-role={role}>
      {text}
    </div>
  ),
}));

vi.mock("../thread/parts/tool-part", () => ({
  ToolPart: ({ part }: { part: any }) => (
    <div data-testid="tool-part">{part.toolName || "tool"}</div>
  ),
}));

vi.mock("../thread/parts/reasoning-part", () => ({
  ReasoningPart: ({
    text,
    state,
    displayMode,
  }: {
    text: string;
    state: string;
    displayMode?: string;
  }) => (
    <div
      data-testid="reasoning-part"
      data-state={state}
      data-display-mode={displayMode ?? "inline"}
    >
      {text}
    </div>
  ),
}));

vi.mock("../thread/parts/file-part", () => ({
  FilePart: ({ part }: { part: any }) => (
    <div data-testid="file-part">{part.filename || "file"}</div>
  ),
}));

vi.mock("../thread/parts/source-url-part", () => ({
  SourceUrlPart: ({ part }: { part: any }) => (
    <div data-testid="source-url-part">{part.url}</div>
  ),
}));

vi.mock("../thread/parts/source-document-part", () => ({
  SourceDocumentPart: ({ part }: { part: any }) => (
    <div data-testid="source-document-part">{part.title}</div>
  ),
}));

vi.mock("../thread/parts/json-part", () => ({
  JsonPart: ({ label, value }: { label: string; value: any }) => (
    <div data-testid="json-part" data-label={label}>
      {JSON.stringify(value)}
    </div>
  ),
}));

// MCPUIResourcePart and ChatGPTAppRenderer were removed in the renderer
// consolidation (Phase 4). All UI-bearing tools now route through
// WidgetReplay → MCPAppsRenderer.

vi.mock("../thread/widget-replay", () => ({
  WidgetReplay: (props: { toolName: string; renderOverride?: any }) => {
    mockWidgetReplay(props);
    return (
      <div
        data-testid="widget-replay"
        data-cached-url={props.renderOverride?.cachedWidgetHtmlUrl ?? ""}
      >
        {props.toolName}
      </div>
    );
  },
}));

vi.mock("convex/react", () => ({
  useConvexAuth: () => ({ isAuthenticated: true }),
}));

vi.mock("@/state/app-state-context", () => ({
  useSharedAppState: () => ({
    projects: {
      default: {
        sharedProjectId: "project-1",
      },
    },
    activeProjectId: "default",
    selectedServer: "selected-server",
    servers: {},
  }),
}));

// Mock thread-helpers
vi.mock("../thread/thread-helpers", () => ({
  isToolPart: (part: any) => part.type === "tool-invocation",
  isDynamicTool: (part: any) => part.type === "dynamic-tool",
  isDataPart: (part: any) => part.type?.endsWith("-data"),
  getToolInfo: (part: any) => ({
    toolName: part.toolName || "test-tool",
    toolCallId: part.toolCallId || "call-123",
    toolState: part.state || "output-available",
    input: part.input,
    output: part.output,
    rawOutput: part.output,
  }),
  getDataLabel: (type: string) => type.replace("-data", ""),
}));

// Mock mcp-tools-api
vi.mock("@/lib/apis/mcp-tools-api", () => ({
  callTool: vi.fn(),
  executeToolApi: vi.fn(),
  getToolServerId: () => "server-1",
}));

vi.mock("@/lib/toast", () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}));

// Mock mcp-apps-utils
vi.mock("@/lib/mcp-ui/mcp-apps-utils", () => ({
  detectUIType: mockDetectUIType,
  getUIResourceUri: () => null,
  UIType: {
    OPENAI_SDK: "openai-apps",
    MCP_APPS: "mcp-apps",
    MCP_UI: "mcp-ui",
    OPENAI_SDK_AND_MCP_APPS: "both",
  },
}));

describe("PartSwitch", () => {
  const defaultProps = {
    role: "user" as UIMessage["role"],
    onSendFollowUp: vi.fn(),
    toolsMetadata: {},
    toolServerMap: {},
    pipWidgetId: null,
    fullscreenWidgetId: null,
    onRequestPip: vi.fn(),
    onExitPip: vi.fn(),
    onRequestFullscreen: vi.fn(),
    onExitFullscreen: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockDetectUIType.mockReturnValue(null);
  });

  describe("text parts", () => {
    it("renders TextPart for text type", () => {
      const part = { type: "text", text: "Hello world" };

      render(<PartSwitch {...defaultProps} part={part as any} />);

      expect(screen.getByTestId("text-part")).toBeInTheDocument();
      expect(screen.getByTestId("text-part")).toHaveTextContent("Hello world");
    });

    it("passes role to TextPart", () => {
      const part = { type: "text", text: "Hello" };

      render(
        <PartSwitch {...defaultProps} part={part as any} role="assistant" />
      );

      expect(screen.getByTestId("text-part")).toHaveAttribute(
        "data-role",
        "assistant"
      );
    });
  });

  describe("reasoning parts", () => {
    it("renders ReasoningPart for reasoning type", () => {
      const part = {
        type: "reasoning",
        text: "Thinking...",
        state: "thinking",
      };

      render(<PartSwitch {...defaultProps} part={part as any} />);

      expect(screen.getByTestId("reasoning-part")).toBeInTheDocument();
      expect(screen.getByTestId("reasoning-part")).toHaveTextContent(
        "Thinking..."
      );
    });

    it("passes state to ReasoningPart", () => {
      const part = { type: "reasoning", text: "Done", state: "done" };

      render(<PartSwitch {...defaultProps} part={part as any} />);

      expect(screen.getByTestId("reasoning-part")).toHaveAttribute(
        "data-state",
        "done"
      );
    });

    it("passes reasoning display mode to ReasoningPart", () => {
      const part = {
        type: "reasoning",
        text: "Hidden in traces",
        state: "done",
      };

      render(
        <PartSwitch
          {...defaultProps}
          part={part as any}
          reasoningDisplayMode="collapsed"
        />
      );

      expect(screen.getByTestId("reasoning-part")).toHaveAttribute(
        "data-display-mode",
        "collapsed"
      );
    });

    it("passes collapsible reasoning display mode to ReasoningPart", () => {
      const part = {
        type: "reasoning",
        text: "Owner thread reasoning",
        state: "done",
      };

      render(
        <PartSwitch
          {...defaultProps}
          part={part as any}
          reasoningDisplayMode="collapsible"
        />
      );

      expect(screen.getByTestId("reasoning-part")).toHaveAttribute(
        "data-display-mode",
        "collapsible"
      );
    });
  });

  describe("file parts", () => {
    it("renders FilePart for file type", () => {
      const part = { type: "file", filename: "test.txt", data: "content" };

      render(<PartSwitch {...defaultProps} part={part as any} />);

      expect(screen.getByTestId("file-part")).toBeInTheDocument();
    });
  });

  describe("source parts", () => {
    it("renders SourceUrlPart for source-url type", () => {
      const part = { type: "source-url", url: "https://example.com" };

      render(<PartSwitch {...defaultProps} part={part as any} />);

      expect(screen.getByTestId("source-url-part")).toBeInTheDocument();
      expect(screen.getByTestId("source-url-part")).toHaveTextContent(
        "https://example.com"
      );
    });

    it("renders SourceDocumentPart for source-document type", () => {
      const part = { type: "source-document", title: "Doc Title" };

      render(<PartSwitch {...defaultProps} part={part as any} />);

      expect(screen.getByTestId("source-document-part")).toBeInTheDocument();
      expect(screen.getByTestId("source-document-part")).toHaveTextContent(
        "Doc Title"
      );
    });
  });

  describe("step-start parts", () => {
    it("returns null for step-start type", () => {
      const part = { type: "step-start" };

      const { container } = render(
        <PartSwitch {...defaultProps} part={part as any} />
      );

      expect(container.firstChild).toBeNull();
    });
  });

  describe("unknown parts", () => {
    it("renders JsonPart for unknown types", () => {
      const part = { type: "unknown-type", data: { foo: "bar" } };

      render(<PartSwitch {...defaultProps} part={part as any} />);

      expect(screen.getByTestId("json-part")).toBeInTheDocument();
      expect(screen.getByTestId("json-part")).toHaveAttribute(
        "data-label",
        "Unknown part"
      );
    });
  });

  describe("data parts", () => {
    it("renders JsonPart for data parts", () => {
      const part = { type: "custom-data", data: { value: 123 } };

      render(<PartSwitch {...defaultProps} part={part as any} />);

      expect(screen.getByTestId("json-part")).toBeInTheDocument();
    });
  });

  describe("tool parts", () => {
    it("renders ToolPart for tool-invocation type", () => {
      const part = {
        type: "tool-invocation",
        toolName: "read_file",
        toolCallId: "call-1",
        state: "output-available",
        input: { path: "/test.txt" },
        output: { content: "file content" },
      };

      render(
        <PartSwitch
          {...defaultProps}
          part={part as any}
          toolsMetadata={{}}
          toolServerMap={{}}
        />
      );

      expect(screen.getByTestId("tool-part")).toBeInTheDocument();
    });

    describe("host capability gate (Bug 1)", () => {
      it("renders WidgetReplay when the host advertises the MCP UI extension", () => {
        mockDetectUIType.mockReturnValue("mcp-apps");
        const part = {
          type: "tool-invocation",
          toolName: "create_view",
          toolCallId: "call-1",
          state: "output-available",
          input: { title: "Flow" },
          output: { content: "saved" },
        };
        const caps = {
          extensions: {
            [MCP_UI_EXTENSION_ID]: {
              mimeTypes: ["text/html;profile=mcp-app"],
            },
          },
        };
        render(
          <ActiveHostCapsResolverProvider value={() => caps}>
            <PartSwitch
              {...defaultProps}
              part={part as any}
              toolsMetadata={{
                create_view: {
                  ui: { resourceUri: "ui://widget/create-view.html" },
                },
              }}
            />
          </ActiveHostCapsResolverProvider>
        );
        expect(screen.getByTestId("widget-replay")).toBeInTheDocument();
      });

      it("falls through to ToolPart when the host strips the UI extension (Codex)", () => {
        mockDetectUIType.mockReturnValue("mcp-apps");
        const part = {
          type: "tool-invocation",
          toolName: "create_view",
          toolCallId: "call-1",
          state: "output-available",
          input: { title: "Flow" },
          output: { content: "saved" },
        };
        // Mirrors the Codex template's REPLACE (not spread) of
        // clientCapabilities — see client-templates.ts:803-810.
        const codexCaps = { elicitation: {} };
        render(
          <ActiveHostCapsResolverProvider value={() => codexCaps}>
            <PartSwitch
              {...defaultProps}
              part={part as any}
              toolsMetadata={{
                create_view: {
                  ui: { resourceUri: "ui://widget/create-view.html" },
                },
              }}
            />
          </ActiveHostCapsResolverProvider>
        );
        expect(screen.queryByTestId("widget-replay")).not.toBeInTheDocument();
        expect(screen.getByTestId("tool-part")).toBeInTheDocument();
      });

      it("renders WidgetReplay when no host is in scope (legacy surfaces)", () => {
        // No provider — context default is `undefined`, which preserves
        // historical tool-metadata-only behavior.
        mockDetectUIType.mockReturnValue("mcp-apps");
        const part = {
          type: "tool-invocation",
          toolName: "create_view",
          toolCallId: "call-1",
          state: "output-available",
          input: { title: "Flow" },
          output: { content: "saved" },
        };
        render(
          <PartSwitch
            {...defaultProps}
            part={part as any}
            toolsMetadata={{
              create_view: {
                ui: { resourceUri: "ui://widget/create-view.html" },
              },
            }}
          />
        );
        expect(screen.getByTestId("widget-replay")).toBeInTheDocument();
      });
    });

    it("reuses WidgetReplay for offline widget overrides", () => {
      mockDetectUIType.mockReturnValue("mcp-apps");
      const part = {
        type: "tool-invocation",
        toolName: "create_view",
        toolCallId: "call-1",
        state: "output-available",
        input: { title: "Flow" },
        output: { content: "saved" },
      };

      render(
        <PartSwitch
          {...defaultProps}
          part={part as any}
          toolsMetadata={{
            create_view: {
              ui: { resourceUri: "ui://widget/create-view.html" },
            },
          }}
          toolRenderOverrides={{
            "call-1": {
              serverId: "server-1",
              isOffline: true,
              cachedWidgetHtmlUrl: "https://storage.example.com/widget.html",
              resourceUri: "ui://widget/create-view.html",
              toolMetadata: {
                ui: { resourceUri: "ui://widget/create-view.html" },
              },
            },
          }}
        />
      );

      expect(screen.getByTestId("widget-replay")).toBeInTheDocument();
      expect(screen.getByTestId("widget-replay")).toHaveAttribute(
        "data-cached-url",
        "https://storage.example.com/widget.html"
      );
      expect(mockWidgetReplay).toHaveBeenCalledWith(
        expect.objectContaining({
          toolName: "create_view",
          renderOverride: expect.objectContaining({
            cachedWidgetHtmlUrl: "https://storage.example.com/widget.html",
          }),
        })
      );
    });

    // SEP-1865 `ui/notifications/request-teardown`: once the host has
    // honored the widget's teardown request, its toolCallId lands in
    // `tornDownWidgetIds` on the Thread. PartSwitch must
    // short-circuit to the plain ToolPart so the iframe unmounts and
    // MCPAppsRenderer's cleanup runs the graceful
    // `bridge.teardownResource` round-trip.
    describe("SEP-1865 teardown dismissal", () => {
      const dismissedPart = {
        type: "tool-invocation",
        toolName: "create_view",
        toolCallId: "call-1",
        state: "output-available",
        input: { title: "Flow" },
        output: { content: "saved" },
      };
      const widgetMetadata = {
        create_view: {
          ui: { resourceUri: "ui://widget/create-view.html" },
        },
      };

      it("renders ToolPart (not WidgetReplay) when toolCallId is dismissed", () => {
        mockDetectUIType.mockReturnValue("mcp-apps");
        render(
          <PartSwitch
            {...defaultProps}
            part={dismissedPart as any}
            toolsMetadata={widgetMetadata}
            tornDownWidgetIds={new Set(["call-1"])}
          />
        );
        expect(screen.queryByTestId("widget-replay")).not.toBeInTheDocument();
        expect(screen.getByTestId("tool-part")).toBeInTheDocument();
      });

      it("still renders WidgetReplay when the dismissed set does not match", () => {
        mockDetectUIType.mockReturnValue("mcp-apps");
        render(
          <PartSwitch
            {...defaultProps}
            part={dismissedPart as any}
            toolsMetadata={widgetMetadata}
            tornDownWidgetIds={new Set(["other-call"])}
          />
        );
        expect(screen.getByTestId("widget-replay")).toBeInTheDocument();
      });

      it("forwards onRequestTeardown to WidgetReplay", () => {
        mockDetectUIType.mockReturnValue("mcp-apps");
        const handleTeardown = vi.fn();
        render(
          <PartSwitch
            {...defaultProps}
            part={dismissedPart as any}
            toolsMetadata={widgetMetadata}
            onRequestTeardown={handleTeardown}
          />
        );
        expect(mockWidgetReplay).toHaveBeenCalledWith(
          expect.objectContaining({ onRequestTeardown: handleTeardown })
        );
      });
    });
  });
});
