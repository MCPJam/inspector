import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ResourceTemplatesTab } from "../ResourceTemplatesTab";
import type { MCPServerConfig } from "@mcpjam/sdk";

const { mockJsonEditor } = vi.hoisted(() => ({
  mockJsonEditor: vi.fn((props: any) => (
    <div data-testid="json-editor">{JSON.stringify(props.value)}</div>
  )),
}));

const mockListResourceTemplates = vi.fn();
const mockReadResource = vi.fn();

vi.mock("@/lib/apis/mcp-resource-templates-api", () => ({
  listResourceTemplates: (...args: unknown[]) =>
    mockListResourceTemplates(...args),
}));

vi.mock("@/lib/apis/mcp-resources-api", () => ({
  readResource: (...args: unknown[]) => mockReadResource(...args),
}));

vi.mock("@/components/ui/json-editor", () => ({
  JsonEditor: (props: any) => mockJsonEditor(props),
}));

vi.mock("../ui/resizable", () => ({
  ResizablePanelGroup: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="resizable-panel-group">{children}</div>
  ),
  ResizablePanel: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="resizable-panel">{children}</div>
  ),
  ResizableHandle: () => <div data-testid="resizable-handle" />,
}));

vi.mock("../logger-view", () => ({
  LoggerView: () => <div data-testid="logger-view">Logger</div>,
}));

vi.mock("../ui/scroll-area", () => ({
  ScrollArea: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="scroll-area">{children}</div>
  ),
}));

describe("ResourceTemplatesTab", () => {
  const createServerConfig = (): MCPServerConfig =>
    ({
      transportType: "stdio",
      command: "node",
      args: ["server.js"],
    }) as MCPServerConfig;

  beforeEach(() => {
    vi.clearAllMocks();
    mockJsonEditor.mockClear();
    mockListResourceTemplates.mockResolvedValue([]);
    mockReadResource.mockResolvedValue({ content: null });
  });

  it("renders JSON text resource template responses with JsonEditor", async () => {
    mockListResourceTemplates.mockResolvedValue([
      { name: "users-template", uriTemplate: "users" },
    ]);
    mockReadResource.mockResolvedValue({
      content: {
        contents: [
          {
            type: "text",
            text: '{"users":[{"id":"1"}],"hasNextPage":false}',
          },
        ],
      },
    });

    render(
      <ResourceTemplatesTab
        serverConfig={createServerConfig()}
        serverName="test-server"
      />,
    );

    await waitFor(() => {
      expect(screen.getByText("users-template")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText("users-template"));

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /read/i })).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("button", { name: /read/i }));

    await waitFor(() => {
      expect(mockJsonEditor).toHaveBeenCalled();
    });

    expect(mockJsonEditor.mock.calls.at(-1)?.[0]).toMatchObject({
      value: { users: [{ id: "1" }], hasNextPage: false },
    });
  });

  it("keeps plain text resource template responses as text", async () => {
    mockListResourceTemplates.mockResolvedValue([
      { name: "notes-template", uriTemplate: "notes" },
    ]);
    mockReadResource.mockResolvedValue({
      content: {
        contents: [{ type: "text", text: "Hello from template" }],
      },
    });

    render(
      <ResourceTemplatesTab
        serverConfig={createServerConfig()}
        serverName="test-server"
      />,
    );

    await waitFor(() => {
      expect(screen.getByText("notes-template")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText("notes-template"));

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /read/i })).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("button", { name: /read/i }));

    await waitFor(() => {
      expect(screen.getByText("Hello from template")).toBeInTheDocument();
    });

    expect(screen.queryByTestId("json-editor")).not.toBeInTheDocument();
  });
});
