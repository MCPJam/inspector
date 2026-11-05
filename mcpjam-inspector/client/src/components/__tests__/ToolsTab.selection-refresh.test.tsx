import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ToolsTab } from "../ToolsTab";
import type { MCPServerConfig } from "@mcpjam/sdk/browser";

const { mockListTools, mockExecuteToolApi, mockSaveRequest } = vi.hoisted(
  () => ({
    mockListTools: vi.fn(),
    mockExecuteToolApi: vi.fn(),
    mockSaveRequest: vi.fn(),
  }),
);
vi.mock("posthog-js/react", () => ({
  usePostHog: () => ({ capture: vi.fn() }),
}));
vi.mock("@/lib/analytics", () => ({ track: vi.fn() }));
vi.mock("@/lib/apis/mcp-tools-api", () => ({
  listTools: (...args: unknown[]) => mockListTools(...args),
  executeToolApi: (...args: unknown[]) => mockExecuteToolApi(...args),
  respondToElicitationApi: vi.fn(),
}));
vi.mock("@/lib/apis/mcp-tasks-api", () => ({
  getTaskCapabilities: vi.fn().mockResolvedValue(null),
}));
vi.mock("@/lib/request-storage", () => ({
  listSavedRequests: vi.fn().mockReturnValue([]),
  saveRequest: mockSaveRequest,
  deleteRequest: vi.fn(),
  duplicateRequest: vi.fn(),
  updateRequestMeta: vi.fn(),
}));
vi.mock("@/hooks/use-logger", () => ({
  useLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));
vi.mock("convex/react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("convex/react")>()),
  useQuery: () => undefined,
}));
vi.mock("@/hooks/useToolQualityEnabled", () => ({
  TOOL_QUALITY_FEATURE_FLAG: "tool-quality-enabled",
  useToolQualityEnabled: () => false,
}));
vi.mock("../ui/resizable", () => ({
  ResizablePanelGroup: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  ResizablePanel: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  ResizableHandle: () => <div />,
}));
vi.mock("../logger-view", () => ({ LoggerView: () => <div /> }));

const tool = (name: string) => ({
  name,
  description: `Selected ${name}`,
  inputSchema: { type: "object", properties: {} },
});

// Select `selected`, optionally act on it, then refresh into a list without it.
async function refreshWithoutSelectedTool({
  selected = "old-tool",
  nextCursor,
  beforeRefresh,
  refreshFails = false,
}: {
  selected?: string;
  nextCursor?: string;
  beforeRefresh?: () => void;
  refreshFails?: boolean;
} = {}) {
  mockListTools.mockResolvedValueOnce({ tools: [tool(selected)] });
  render(
    <ToolsTab
      serverConfig={{ command: "node" } as MCPServerConfig}
      serverName="test-server"
    />,
  );
  fireEvent.click(await screen.findByText(selected));
  await waitFor(() =>
    expect(screen.queryByText("No selection")).not.toBeInTheDocument(),
  );
  beforeRefresh?.();
  if (refreshFails) mockListTools.mockRejectedValueOnce(new Error("list down"));
  else
    mockListTools.mockResolvedValueOnce({
      tools: [tool("new-tool")],
      ...(nextCursor ? { nextCursor } : {}),
    });
  fireEvent.click(screen.getByTitle("Refresh tools"));
  await waitFor(() => expect(mockListTools).toHaveBeenCalledTimes(2));
  await waitFor(() =>
    expect(screen.getByTitle("Refresh tools")).not.toBeDisabled(),
  );
}

describe("ToolsTab selection across a list refresh", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("drops a selected tool that left the list", async () => {
    await refreshWithoutSelectedTool();
    expect(await screen.findByText("new-tool")).toBeInTheDocument();
    expect(screen.getByText("No selection")).toBeInTheDocument();
  });

  it("drops a removed tool whose name is also an object property", async () => {
    await refreshWithoutSelectedTool({ selected: "toString" });
    expect(screen.getByText("No selection")).toBeInTheDocument();
  });

  it("keeps a selected tool that a paged list may hold on a later page", async () => {
    await refreshWithoutSelectedTool({ nextCursor: "page-2" });
    expect(screen.getByText("old-tool")).toBeInTheDocument();
    expect(screen.queryByText("No selection")).not.toBeInTheDocument();
  });

  it("keeps a removed tool selected while its call runs, then disables it", async () => {
    let finish!: (response: unknown) => void;
    mockExecuteToolApi.mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    await refreshWithoutSelectedTool({
      beforeRefresh: () =>
        fireEvent.click(screen.getByRole("button", { name: /^run/i })),
    });
    expect(screen.queryByText("No selection")).not.toBeInTheDocument();
    finish({
      status: "completed",
      result: { content: [{ type: "text", text: "call finished" }] },
    });
    // The result stays under its tool, which can no longer run or be saved.
    expect(await screen.findByText(/call finished/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^run/i })).toBeDisabled();
    expect(screen.getByTitle("Save request")).toBeDisabled();
    fireEvent.keyDown(window, { key: "Enter" });
    expect(mockExecuteToolApi).toHaveBeenCalledTimes(1);
  });

  it("keeps a selected tool and its definition when the refresh fails", async () => {
    await refreshWithoutSelectedTool({ refreshFails: true });
    expect(screen.queryByText("No selection")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^run/i })).toBeEnabled();
    // The form and task policy come from the definition, so it must survive.
    expect(screen.getByText("Selected old-tool")).toBeInTheDocument();
  });

  it("does not save an empty request when the tool leaves the list", async () => {
    await refreshWithoutSelectedTool({
      beforeRefresh: () => fireEvent.click(screen.getByTitle("Save request")),
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(mockSaveRequest).not.toHaveBeenCalled();
    expect(screen.queryByText("Save request")).not.toBeInTheDocument();
  });
});
