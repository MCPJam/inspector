import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ReactFlowProvider } from "@xyflow/react";
import { ChatboxCanvas } from "../ChatboxCanvas";
import { buildChatboxCanvas } from "../chatboxCanvasBuilder";
import {
  getChatboxCanvasStaticFitBounds,
  CHATBOX_BUILDER_HOST_OVERFLOW_BELOW,
} from "../chatbox-canvas-viewport";
import type { ChatboxBuilderContext } from "../types";

const fitBounds = vi.fn();
const getNodesBounds = vi.fn();

let mockViewportInitialized = true;
let mockNodesInitialized = true;

vi.mock("@xyflow/react", async () => {
  const actual =
    await vi.importActual<typeof import("@xyflow/react")>("@xyflow/react");
  return {
    ...actual,
    useNodesInitialized: () => mockNodesInitialized,
    useReactFlow: () => ({
      fitBounds,
      getNodesBounds,
      viewportInitialized: mockViewportInitialized,
      setCenter: vi.fn(),
      fitView: vi.fn(),
      getZoom: () => 1,
      getViewport: () => ({ x: 0, y: 0, zoom: 1 }),
      setViewport: vi.fn(),
    }),
  };
});

type ROInstance = {
  callback: ResizeObserverCallback;
  observed: Element;
};

let resizeObserverInstances: ROInstance[] = [];
const OriginalResizeObserver = global.ResizeObserver;
let boundingRectSpy: ReturnType<typeof vi.spyOn> | null = null;

beforeEach(() => {
  if (typeof window.DOMMatrixReadOnly === "undefined") {
    window.DOMMatrixReadOnly = class {
      constructor(_init?: string | number[]) {}
    } as unknown as typeof DOMMatrixReadOnly;
  }

  fitBounds.mockReset();
  getNodesBounds.mockReset();
  getNodesBounds.mockReturnValue({
    x: 0,
    y: 0,
    width: 400,
    height: 300,
  });
  mockViewportInitialized = true;
  mockNodesInitialized = true;
  resizeObserverInstances = [];
  global.ResizeObserver = vi
    .fn()
    .mockImplementation((callback: ResizeObserverCallback) => ({
      observe: vi.fn((el: Element) => {
        resizeObserverInstances.push({ callback, observed: el });
      }),
      disconnect: vi.fn(),
      unobserve: vi.fn(),
    })) as unknown as typeof ResizeObserver;

  boundingRectSpy = vi
    .spyOn(HTMLElement.prototype, "getBoundingClientRect")
    .mockReturnValue({
      x: 0,
      y: 0,
      width: 800,
      height: 600,
      top: 0,
      left: 0,
      bottom: 600,
      right: 800,
      toJSON: () => "",
    } as DOMRect);
});

afterEach(() => {
  global.ResizeObserver = OriginalResizeObserver;
  boundingRectSpy?.mockRestore();
  boundingRectSpy = null;
});

function flushResizeObservers(width: number, height: number) {
  for (const inst of resizeObserverInstances) {
    inst.callback(
      [
        {
          target: inst.observed,
          contentRect: {
            x: 0,
            y: 0,
            width,
            height,
            top: 0,
            left: 0,
            bottom: height,
            right: width,
            toJSON: () => "",
          } as DOMRectReadOnly,
        } as ResizeObserverEntry,
      ],
      {} as ResizeObserver,
    );
  }
}

async function flushViewportFit() {
  await waitFor(() => {
    expect(fitBounds).toHaveBeenCalled();
  });
}

describe("ChatboxCanvas", () => {
  it("exposes full title and subtitle via native title tooltips on nodes", () => {
    const context: ChatboxBuilderContext = {
      chatbox: null,
      draft: {
        name: "My very long chatbox name that might truncate in the UI",
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

    getNodesBounds.mockReturnValue({
      x: 0,
      y: 0,
      width: 400,
      height: 300,
    });

    const viewModel = buildChatboxCanvas(context);

    render(
      <ReactFlowProvider>
        <ChatboxCanvas
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
      "My very long chatbox name that might truncate in the UI",
    );
    expect(nameSubtitle).toHaveAttribute(
      "title",
      "My very long chatbox name that might truncate in the UI",
    );

    const serverTitle = screen.getByText("Production MCP");
    expect(serverTitle).toHaveAttribute("title", "Production MCP");

    const urlEl = screen.getByText("https://example.com/very/long/path/to/mcp");
    expect(urlEl).toHaveAttribute(
      "title",
      "https://example.com/very/long/path/to/mcp",
    );
  });

  it("opens a workspace server picker from the host + control", () => {
    const context: ChatboxBuilderContext = {
      chatbox: null,
      draft: {
        name: "Test",
        description: "",
        hostStyle: "claude",
        systemPrompt: "x",
        modelId: "openai/gpt-5-mini",
        temperature: 0.7,
        requireToolApproval: false,
        allowGuestAccess: false,
        mode: "any_signed_in_with_link",
        selectedServerIds: [],
        optionalServerIds: [],
        welcomeDialog: { enabled: true, body: "" },
        feedbackDialog: { enabled: true, everyNToolCalls: 1, promptHint: "" },
      },
      workspaceServers: [
        {
          _id: "srv1",
          workspaceId: "ws",
          name: "HTTPS Server",
          enabled: true,
          transportType: "http",
          url: "https://example.com/mcp",
          createdAt: 1,
          updatedAt: 1,
        },
      ],
    };

    getNodesBounds.mockReturnValue({
      x: 0,
      y: 0,
      width: 400,
      height: 300,
    });

    const viewModel = buildChatboxCanvas(context);
    const onToggle = vi.fn();
    const onOpenAdd = vi.fn();

    render(
      <ReactFlowProvider>
        <ChatboxCanvas
          viewModel={viewModel}
          selectedNodeId={null}
          onSelectNode={() => {}}
          onClearSelection={() => {}}
          canvasServerPicker={{
            workspaceServers: context.workspaceServers,
            selectedServerIds: [],
            onToggleServer: onToggle,
            onOpenAddWorkspaceServer: onOpenAdd,
          }}
        />
      </ReactFlowProvider>,
    );

    const addTrigger = document.querySelector<HTMLButtonElement>(
      '[aria-label="Add workspace servers to chatbox"]',
    );
    expect(addTrigger).not.toBeNull();
    fireEvent.click(addTrigger!);

    expect(
      screen.getByText(
        "Pick HTTPS servers from your workspace for this chatbox.",
      ),
    ).toBeInTheDocument();
    expect(screen.getByText("HTTPS Server")).toBeInTheDocument();

    fireEvent.click(
      screen.getByRole("button", { name: /Add server to workspace/ }),
    );
    expect(onOpenAdd).toHaveBeenCalledTimes(1);
  });

  it("fits using bounds for all chatbox nodes, not only the host", async () => {
    getNodesBounds.mockReturnValue({
      x: 0,
      y: 0,
      width: 900,
      height: 400,
    });

    const context: ChatboxBuilderContext = {
      chatbox: null,
      draft: {
        name: "Multi",
        description: "",
        hostStyle: "claude",
        systemPrompt: "x",
        modelId: "openai/gpt-5-mini",
        temperature: 0.7,
        requireToolApproval: false,
        allowGuestAccess: false,
        mode: "any_signed_in_with_link",
        selectedServerIds: ["a", "b"],
        optionalServerIds: [],
        welcomeDialog: { enabled: true, body: "" },
        feedbackDialog: { enabled: true, everyNToolCalls: 1, promptHint: "" },
      },
      workspaceServers: [
        {
          _id: "a",
          workspaceId: "ws",
          name: "A",
          enabled: true,
          transportType: "http",
          url: "https://a.example/mcp",
          createdAt: 1,
          updatedAt: 1,
        },
        {
          _id: "b",
          workspaceId: "ws",
          name: "B",
          enabled: true,
          transportType: "http",
          url: "https://b.example/mcp",
          createdAt: 1,
          updatedAt: 1,
        },
      ],
    };
    const viewModel = buildChatboxCanvas(context);

    render(
      <ReactFlowProvider>
        <ChatboxCanvas
          viewModel={viewModel}
          selectedNodeId={null}
          onSelectNode={() => {}}
          onClearSelection={() => {}}
        />
      </ReactFlowProvider>,
    );

    await flushViewportFit();
    expect(getNodesBounds).toHaveBeenCalled();
    const ids = getNodesBounds.mock.calls[0][0] as string[];
    expect(ids).toContain("host");
    expect(ids).toContain("server:a");
    expect(ids).toContain("server:b");
    expect(ids.length).toBe(3);
  });

  it("refits once when servers are added then does not repeat without layout change", async () => {
    getNodesBounds.mockReturnValue({
      x: 0,
      y: 0,
      width: 500,
      height: 300,
    });

    const baseDraft = {
      name: "X",
      description: "",
      hostStyle: "claude" as const,
      systemPrompt: "x",
      modelId: "openai/gpt-5-mini",
      temperature: 0.7,
      requireToolApproval: false,
      allowGuestAccess: false,
      mode: "any_signed_in_with_link" as const,
      optionalServerIds: [] as string[],
      welcomeDialog: { enabled: true, body: "" },
      feedbackDialog: { enabled: true, everyNToolCalls: 1, promptHint: "" },
    };

    const server = {
      _id: "srv1",
      workspaceId: "ws",
      name: "S1",
      enabled: true,
      transportType: "http" as const,
      url: "https://example.com/mcp",
      createdAt: 1,
      updatedAt: 1,
    };

    const vm0 = buildChatboxCanvas(
      minimalContext({ ...baseDraft, selectedServerIds: [] }),
    );
    const vm1 = buildChatboxCanvas(
      minimalContext({
        ...baseDraft,
        selectedServerIds: ["srv1"],
        workspaceServers: [server],
      }),
    );

    const { rerender } = render(
      <ReactFlowProvider>
        <ChatboxCanvas
          viewModel={vm0}
          selectedNodeId={null}
          onSelectNode={() => {}}
          onClearSelection={() => {}}
          canvasViewportRefitNonce={0}
        />
      </ReactFlowProvider>,
    );

    await flushViewportFit();
    expect(fitBounds).toHaveBeenCalledTimes(1);
    fitBounds.mockClear();

    rerender(
      <ReactFlowProvider>
        <ChatboxCanvas
          viewModel={vm1}
          selectedNodeId={null}
          onSelectNode={() => {}}
          onClearSelection={() => {}}
          canvasViewportRefitNonce={0}
        />
      </ReactFlowProvider>,
    );

    await waitFor(() => expect(fitBounds).toHaveBeenCalledTimes(1));

    const vm2 = buildChatboxCanvas(
      minimalContext({ ...baseDraft, selectedServerIds: [] }),
    );
    fitBounds.mockClear();
    rerender(
      <ReactFlowProvider>
        <ChatboxCanvas
          viewModel={vm2}
          selectedNodeId={null}
          onSelectNode={() => {}}
          onClearSelection={() => {}}
          canvasViewportRefitNonce={0}
        />
      </ReactFlowProvider>,
    );

    await waitFor(() => expect(fitBounds).toHaveBeenCalledTimes(1));

    fitBounds.mockClear();
    rerender(
      <ReactFlowProvider>
        <ChatboxCanvas
          viewModel={vm2}
          selectedNodeId={null}
          onSelectNode={() => {}}
          onClearSelection={() => {}}
          canvasViewportRefitNonce={0}
        />
      </ReactFlowProvider>,
    );

    await new Promise((r) => setTimeout(r, 120));
    expect(fitBounds).not.toHaveBeenCalled();
  });

  it("refits when canvasViewportRefitNonce changes with same layout", async () => {
    getNodesBounds.mockReturnValue({
      x: 0,
      y: 0,
      width: 400,
      height: 300,
    });

    const vm = buildChatboxCanvas(minimalContext());

    const { rerender } = render(
      <ReactFlowProvider>
        <ChatboxCanvas
          viewModel={vm}
          selectedNodeId={null}
          onSelectNode={() => {}}
          onClearSelection={() => {}}
          canvasViewportRefitNonce={0}
        />
      </ReactFlowProvider>,
    );

    await flushViewportFit();
    expect(fitBounds).toHaveBeenCalledTimes(1);
    fitBounds.mockClear();

    rerender(
      <ReactFlowProvider>
        <ChatboxCanvas
          viewModel={vm}
          selectedNodeId={null}
          onSelectNode={() => {}}
          onClearSelection={() => {}}
          canvasViewportRefitNonce={1}
        />
      </ReactFlowProvider>,
    );

    await waitFor(() => expect(fitBounds).toHaveBeenCalledTimes(1));
  });

  it("does not refit when only selectedNodeId changes", async () => {
    getNodesBounds.mockReturnValue({
      x: 0,
      y: 0,
      width: 400,
      height: 300,
    });

    const vm = buildChatboxCanvas(minimalContext());

    const { rerender } = render(
      <ReactFlowProvider>
        <ChatboxCanvas
          viewModel={vm}
          selectedNodeId={null}
          onSelectNode={() => {}}
          onClearSelection={() => {}}
        />
      </ReactFlowProvider>,
    );

    await flushViewportFit();
    fitBounds.mockClear();

    rerender(
      <ReactFlowProvider>
        <ChatboxCanvas
          viewModel={vm}
          selectedNodeId="host"
          onSelectNode={() => {}}
          onClearSelection={() => {}}
        />
      </ReactFlowProvider>,
    );

    await new Promise((r) => setTimeout(r, 120));
    expect(fitBounds).not.toHaveBeenCalled();
  });

  it("does not refit when ResizeObserver reports the same container size", async () => {
    const vm = buildChatboxCanvas(minimalContext());

    render(
      <ReactFlowProvider>
        <ChatboxCanvas
          viewModel={vm}
          selectedNodeId={null}
          onSelectNode={() => {}}
          onClearSelection={() => {}}
        />
      </ReactFlowProvider>,
    );

    await flushViewportFit();
    fitBounds.mockClear();

    flushResizeObservers(800, 600);
    await new Promise((r) => setTimeout(r, 120));
    expect(fitBounds).not.toHaveBeenCalled();
  });

  it("refits when container width changes via ResizeObserver", async () => {
    getNodesBounds.mockReturnValue({
      x: 0,
      y: 0,
      width: 400,
      height: 300,
    });

    const vm = buildChatboxCanvas(minimalContext());

    render(
      <ReactFlowProvider>
        <ChatboxCanvas
          viewModel={vm}
          selectedNodeId={null}
          onSelectNode={() => {}}
          onClearSelection={() => {}}
        />
      </ReactFlowProvider>,
    );

    await flushViewportFit();
    expect(fitBounds).toHaveBeenCalledTimes(1);
    fitBounds.mockClear();

    flushResizeObservers(500, 600);
    await waitFor(() => expect(fitBounds).toHaveBeenCalledTimes(1));
  });

  it("refits when container height changes via ResizeObserver", async () => {
    getNodesBounds.mockReturnValue({
      x: 0,
      y: 0,
      width: 400,
      height: 300,
    });

    const vm = buildChatboxCanvas(minimalContext());

    render(
      <ReactFlowProvider>
        <ChatboxCanvas
          viewModel={vm}
          selectedNodeId={null}
          onSelectNode={() => {}}
          onClearSelection={() => {}}
        />
      </ReactFlowProvider>,
    );

    await flushViewportFit();
    fitBounds.mockClear();

    flushResizeObservers(800, 400);
    await waitFor(() => expect(fitBounds).toHaveBeenCalledTimes(1));
  });

  it("uses static fallback bounds when measured React Flow bounds are invalid", async () => {
    getNodesBounds.mockReturnValue({
      x: 0,
      y: 0,
      width: 4,
      height: 4,
    });

    const vm = buildChatboxCanvas(minimalContext());
    const expected = getChatboxCanvasStaticFitBounds(vm.nodes);
    expect(expected).not.toBeNull();

    render(
      <ReactFlowProvider>
        <ChatboxCanvas
          viewModel={vm}
          selectedNodeId={null}
          onSelectNode={() => {}}
          onClearSelection={() => {}}
        />
      </ReactFlowProvider>,
    );

    await flushViewportFit();
    expect(fitBounds).toHaveBeenCalledWith(
      {
        x: expected!.x,
        y: expected!.y,
        width: expected!.width,
        height: expected!.height,
      },
      expect.objectContaining({
        padding: expect.any(Number),
        duration: expect.any(Number),
      }),
    );
    expect(expected!.height).toBeGreaterThanOrEqual(
      128 + CHATBOX_BUILDER_HOST_OVERFLOW_BELOW - 1,
    );
  });
});

function minimalContext(
  overrides: Partial<ChatboxBuilderContext["draft"]> & {
    workspaceServers?: ChatboxBuilderContext["workspaceServers"];
  } = {},
): ChatboxBuilderContext {
  const draft = {
    name: "T",
    description: "",
    hostStyle: "claude" as const,
    systemPrompt: "x",
    modelId: "openai/gpt-5-mini",
    temperature: 0.7,
    requireToolApproval: false,
    allowGuestAccess: false,
    mode: "any_signed_in_with_link" as const,
    selectedServerIds: [] as string[],
    optionalServerIds: [] as string[],
    welcomeDialog: { enabled: true, body: "" },
    feedbackDialog: { enabled: true, everyNToolCalls: 1, promptHint: "" },
    ...overrides,
  };
  return {
    chatbox: null,
    draft,
    workspaceServers: overrides.workspaceServers ?? [],
  };
}
