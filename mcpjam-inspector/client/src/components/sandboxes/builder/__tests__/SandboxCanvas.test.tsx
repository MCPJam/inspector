import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { ReactFlowProvider } from "@xyflow/react";
import { SandboxCanvas } from "../SandboxCanvas";
import { buildSandboxCanvas } from "../sandboxCanvasBuilder";
import type { SandboxBuilderContext } from "../types";

vi.mock("@xyflow/react", async () => {
  const actual =
    await vi.importActual<typeof import("@xyflow/react")>("@xyflow/react");
  return {
    ...actual,
    useNodesInitialized: () => true,
    useReactFlow: () => ({
      fitView: vi.fn(),
      setCenter: vi.fn(),
      getZoom: () => 1,
    }),
  };
});

describe("SandboxCanvas", () => {
  it("exposes full title and subtitle via native title tooltips on nodes", () => {
    const context: SandboxBuilderContext = {
      sandbox: null,
      draft: {
        name: "My very long sandbox name that might truncate in the UI",
        description: "",
        hostStyle: "claude",
        systemPrompt: "x",
        modelId: "openai/gpt-5-mini",
        temperature: 0.7,
        requireToolApproval: false,
        allowGuestAccess: false,
        mode: "any_signed_in_with_link",
        selectedServerIds: ["srv1"],
        optionalServerIds: [],
        welcomeDialog: { enabled: true, body: "" },
        feedbackDialog: { enabled: true, everyNToolCalls: 1, promptHint: "" },
      },
      workspaceServers: [
        {
          _id: "srv1",
          workspaceId: "ws",
          name: "Production MCP",
          enabled: true,
          transportType: "http",
          url: "https://example.com/very/long/path/to/mcp",
          createdAt: 1,
          updatedAt: 1,
        },
      ],
    };

    const viewModel = buildSandboxCanvas(context);

    render(
      <ReactFlowProvider>
        <SandboxCanvas
          viewModel={viewModel}
          selectedNodeId={null}
          onSelectNode={() => {}}
          onClearSelection={() => {}}
        />
      </ReactFlowProvider>,
    );

    const hostTitle = screen.getByText("Chat Interface");
    expect(hostTitle).toHaveAttribute("title", "Chat Interface");

    const nameSubtitle = screen.getByText(
      "My very long sandbox name that might truncate in the UI",
    );
    expect(nameSubtitle).toHaveAttribute(
      "title",
      "My very long sandbox name that might truncate in the UI",
    );

    const serverTitle = screen.getByText("Production MCP");
    expect(serverTitle).toHaveAttribute("title", "Production MCP");

    const urlEl = screen.getByText("https://example.com/very/long/path/to/mcp");
    expect(urlEl).toHaveAttribute(
      "title",
      "https://example.com/very/long/path/to/mcp",
    );
  });
});
