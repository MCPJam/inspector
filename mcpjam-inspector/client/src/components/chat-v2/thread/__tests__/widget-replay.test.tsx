import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { WidgetReplay } from "../widget-replay";
import { ChatboxHostStyleProvider } from "@/contexts/chatbox-host-style-context";

const mockDetectUIType = vi.fn();

vi.mock("../chatgpt-app-renderer", () => ({
  ChatGPTAppRenderer: ({ toolName }: { toolName: string }) => (
    <div data-testid="chatgpt-renderer">{toolName}</div>
  ),
}));

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
    mockDetectUIType.mockReturnValue("openai-sdk-and-mcp-apps");
  });

  it("prefers the OpenAI renderer for ChatGPT chatboxes", () => {
    render(
      <ChatboxHostStyleProvider value="chatgpt">
        <WidgetReplay {...baseProps} />
      </ChatboxHostStyleProvider>,
    );

    expect(screen.getByTestId("chatgpt-renderer")).toBeInTheDocument();
    expect(screen.queryByTestId("mcp-apps-renderer")).not.toBeInTheDocument();
  });

  it("prefers the MCP Apps renderer for Claude chatboxes", () => {
    render(
      <ChatboxHostStyleProvider value="claude">
        <WidgetReplay {...baseProps} />
      </ChatboxHostStyleProvider>,
    );

    expect(screen.getByTestId("mcp-apps-renderer")).toBeInTheDocument();
    expect(screen.queryByTestId("chatgpt-renderer")).not.toBeInTheDocument();
  });
});
