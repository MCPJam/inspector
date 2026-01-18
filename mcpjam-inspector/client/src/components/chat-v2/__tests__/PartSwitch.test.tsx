import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { PartSwitch } from "../thread/part-switch";
import type { UIMessage } from "@ai-sdk/react";

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
  ReasoningPart: ({ text, state }: { text: string; state: string }) => (
    <div data-testid="reasoning-part" data-state={state}>
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

vi.mock("../thread/parts/mcp-ui-resource-part", () => ({
  MCPUIResourcePart: ({ resource }: { resource: any }) => (
    <div data-testid="mcp-ui-resource-part">{resource?.uri}</div>
  ),
}));

vi.mock("../thread/chatgpt-app-renderer", () => ({
  ChatGPTAppRenderer: ({ toolName }: { toolName: string }) => (
    <div data-testid="chatgpt-app-renderer">{toolName}</div>
  ),
}));

vi.mock("../thread/mcp-apps-renderer", () => ({
  MCPAppsRenderer: ({ toolName }: { toolName: string }) => (
    <div data-testid="mcp-apps-renderer">{toolName}</div>
  ),
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
  extractUIResource: () => null,
}));

// Mock mcp-tools-api
vi.mock("@/lib/apis/mcp-tools-api", () => ({
  callTool: vi.fn(),
  getToolServerId: () => "server-1",
}));

// Mock mcp-apps-utils
vi.mock("@/lib/mcp-ui/mcp-apps-utils", () => ({
  detectUIType: () => null,
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

      render(<PartSwitch {...defaultProps} part={part as any} role="assistant" />);

      expect(screen.getByTestId("text-part")).toHaveAttribute(
        "data-role",
        "assistant"
      );
    });
  });

  describe("reasoning parts", () => {
    it("renders ReasoningPart for reasoning type", () => {
      const part = { type: "reasoning", text: "Thinking...", state: "thinking" };

      render(<PartSwitch {...defaultProps} part={part as any} />);

      expect(screen.getByTestId("reasoning-part")).toBeInTheDocument();
      expect(screen.getByTestId("reasoning-part")).toHaveTextContent(
        "Thinking..."
      );
    });

    it("passes state to ReasoningPart", () => {
      const part = { type: "reasoning", text: "Done", state: "complete" };

      render(<PartSwitch {...defaultProps} part={part as any} />);

      expect(screen.getByTestId("reasoning-part")).toHaveAttribute(
        "data-state",
        "complete"
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
  });
});
