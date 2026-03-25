import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { LearningToolsExplorer } from "../LearningToolsExplorer";

const { useLearningServerMock, listToolsMock, executeToolApiMock } = vi.hoisted(
  () => ({
    useLearningServerMock: vi.fn(),
    listToolsMock: vi.fn(),
    executeToolApiMock: vi.fn(),
  }),
);

vi.mock("@/hooks/use-learning-server", () => ({
  useLearningServer: useLearningServerMock,
}));

vi.mock("@/lib/apis/mcp-tools-api", () => ({
  listTools: listToolsMock,
  executeToolApi: executeToolApiMock,
}));

vi.mock("../LearningSandboxShell", () => ({
  LearningSandboxShell: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

vi.mock("../LearningSandboxServerInfoPanel", () => ({
  LearningSandboxServerInfoPanel: () => null,
}));

vi.mock("@/components/chat-v2/thread/mcp-apps/mcp-apps-renderer", () => ({
  MCPAppsRenderer: ({
    toolName,
    toolInput,
  }: {
    toolName: string;
    toolInput: Record<string, unknown>;
  }) => (
    <div data-testid="mcp-app-renderer">
      {JSON.stringify({ toolName, toolInput })}
    </div>
  ),
}));

vi.mock("@/components/ui/json-editor", () => ({
  JsonEditor: ({
    rawContent,
    onRawChange,
    value,
    readOnly,
  }: {
    rawContent?: string;
    onRawChange?: (value: string) => void;
    value?: unknown;
    readOnly?: boolean;
  }) =>
    readOnly ? (
      <div data-testid="json-editor-readonly">{JSON.stringify(value)}</div>
    ) : (
      <textarea
        data-testid="json-editor-edit"
        value={rawContent}
        onChange={(event) => onRawChange?.(event.target.value)}
      />
    ),
}));

vi.mock("@/components/ui/tabs", () => ({
  Tabs: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  TabsList: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  TabsTrigger: ({ children }: { children: ReactNode }) => (
    <button type="button">{children}</button>
  ),
  TabsContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

describe("LearningToolsExplorer", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useLearningServerMock.mockReturnValue({
      serverId: "__learning__",
      serverEntry: undefined,
      initInfo: undefined,
      status: "connected",
      error: undefined,
      isConnected: true,
      isConnecting: false,
      connect: vi.fn(),
      reconnect: vi.fn(),
      disconnect: vi.fn(),
    });
  });

  it("clears the inline app snapshot when the editor input changes after a run", async () => {
    listToolsMock.mockResolvedValue({
      tools: [
        {
          name: "display-mcp-app",
          description: "Render a widget",
          inputSchema: {
            type: "object",
            properties: {
              greeting: { type: "string" },
            },
          },
        },
      ],
      toolsMetadata: {
        "display-mcp-app": {
          ui: { resourceUri: "ui://widget/render.html" },
        },
      },
    });
    executeToolApiMock.mockResolvedValue({
      status: "completed",
      result: {
        content: [{ type: "text", text: "done" }],
      },
    });

    render(<LearningToolsExplorer />);

    await waitFor(() => {
      expect(listToolsMock).toHaveBeenCalledWith({ serverId: "__learning__" });
    });

    fireEvent.click(await screen.findByRole("button", { name: "Run tool" }));

    expect(
      await screen.findByTestId("mcp-app-renderer"),
    ).toBeInTheDocument();

    fireEvent.change(screen.getByTestId("json-editor-edit"), {
      target: { value: '{"greeting":"changed"}' },
    });

    await waitFor(() => {
      expect(screen.queryByTestId("mcp-app-renderer")).not.toBeInTheDocument();
    });
  });
});
