import type { ReactNode } from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  act,
  render,
  screen,
  fireEvent,
  within,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { TraceViewer } from "../trace-viewer";

vi.mock("@/components/ui/resizable", () => ({
  ResizablePanelGroup: ({ children }: { children: ReactNode }) => (
    <div data-testid="resizable-panel-group">{children}</div>
  ),
  ResizablePanel: ({ children }: { children: ReactNode }) => (
    <div data-testid="resizable-panel">{children}</div>
  ),
  ResizableHandle: () => <div data-testid="resizable-handle" />,
}));

const { mockMessageView, mockJsonEditor } = vi.hoisted(() => ({
  mockMessageView: vi.fn(),
  mockJsonEditor: vi.fn(),
}));

vi.mock("@/stores/preferences/preferences-provider", () => ({
  usePreferencesStore: (selector: (state: { themeMode: string }) => unknown) =>
    selector({ themeMode: "light" }),
}));

vi.mock("@/lib/provider-logos", () => ({
  getProviderLogo: () => null,
}));

vi.mock("sonner", () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock("@/components/ui/json-editor", () => ({
  JsonEditor: (props: {
    value: unknown;
    height?: string;
    viewOnly?: boolean;
  }) => {
    mockJsonEditor(props);
    return <div data-testid="json-editor">{JSON.stringify(props.value)}</div>;
  },
}));

vi.mock("@/components/chat-v2/thread/message-view", () => ({
  MessageView: (props: Record<string, unknown>) => {
    mockMessageView(props);
    const message = props.message as {
      id: string;
      role: string;
      parts: unknown[];
    };
    return (
      <div
        data-testid="message-view"
        data-message-id={message.id}
        data-role={message.role}
      >
        {message.parts?.map((part: any, i: number) => (
          <div
            key={i}
            data-testid={`part-${part.type}`}
            data-part-type={part.type}
          >
            {part.type === "text" ? part.text : null}
          </div>
        ))}
      </div>
    );
  },
}));

const simpleTextTrace = {
  messages: [
    { role: "user", content: "Hello" },
    {
      role: "assistant",
      content: [{ type: "text", text: "Hi there!" }],
    },
  ],
};

const reasoningTrace = {
  messages: [
    {
      role: "assistant",
      content: [
        {
          type: "reasoning",
          text: "Thinking through the tool choice.",
          state: "done",
        },
        {
          type: "text",
          text: "I should call the server listing tool.",
        },
      ],
    },
  ],
};

const toolTrace = {
  messages: [
    {
      role: "assistant",
      content: [
        {
          type: "tool-call",
          toolCallId: "call-1",
          toolName: "create_view",
          input: { title: "Flow" },
        },
      ],
    },
    {
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: "call-1",
          toolName: "create_view",
          output: { type: "json", value: { ok: true } },
        },
      ],
    },
  ],
};

const widgetSnapshotTrace = {
  ...toolTrace,
  widgetSnapshots: [
    {
      toolCallId: "call-1",
      toolName: "create_view",
      protocol: "mcp-apps" as const,
      serverId: "server-1",
      resourceUri: "ui://widget/create-view.html",
      toolMetadata: {
        ui: { resourceUri: "ui://widget/create-view.html" },
      },
      widgetCsp: null,
      widgetPermissions: null,
      widgetPermissive: true,
      prefersBorder: true,
      widgetHtmlUrl: "https://storage.example.com/widget.html",
    },
  ],
};

const waterfallTrace = {
  traceVersion: 1 as const,
  messages: [
    { role: "user", content: "Need docs" },
    {
      role: "assistant",
      content: [
        {
          type: "tool-call",
          toolCallId: "call-docs",
          toolName: "read_docs",
          input: { topic: "telemetry" },
        },
      ],
    },
    {
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: "call-docs",
          toolName: "read_docs",
          output: {
            type: "json",
            value: { ok: true, pages: 3 },
          },
        },
      ],
    },
    {
      role: "assistant",
      content: [{ type: "text", text: "Telemetry docs loaded." }],
    },
    { role: "user", content: "Summarize it" },
    {
      role: "assistant",
      content: [{ type: "text", text: "Summary ready." }],
    },
  ],
  spans: [
    {
      id: "p0-step0",
      name: "Step 1",
      category: "step" as const,
      startMs: 0,
      endMs: 120,
      promptIndex: 0,
      stepIndex: 0,
      status: "ok" as const,
      modelId: "gpt-4o",
      inputTokens: 20,
      outputTokens: 12,
      totalTokens: 32,
      messageStartIndex: 1,
      messageEndIndex: 3,
    },
    {
      id: "p0-llm0",
      parentId: "p0-step0",
      name: "LLM",
      category: "llm" as const,
      startMs: 0,
      endMs: 50,
      promptIndex: 0,
      stepIndex: 0,
      status: "ok" as const,
      modelId: "gpt-4o",
      messageStartIndex: 1,
      messageEndIndex: 3,
    },
    {
      id: "p0-tool0",
      parentId: "p0-step0",
      name: "read_docs",
      category: "tool" as const,
      startMs: 40,
      endMs: 90,
      promptIndex: 0,
      stepIndex: 0,
      status: "ok" as const,
      toolCallId: "call-docs",
      toolName: "read_docs",
      serverId: "docs-server",
      messageStartIndex: 1,
      messageEndIndex: 2,
    },
    {
      id: "p1-step0",
      name: "Step 1",
      category: "step" as const,
      startMs: 140,
      endMs: 260,
      promptIndex: 1,
      stepIndex: 0,
      status: "error" as const,
      modelId: "gpt-4.1",
      messageStartIndex: 5,
      messageEndIndex: 5,
    },
    {
      id: "p1-llm0",
      parentId: "p1-step0",
      name: "LLM",
      category: "llm" as const,
      startMs: 140,
      endMs: 240,
      promptIndex: 1,
      stepIndex: 0,
      status: "error" as const,
      modelId: "gpt-4.1",
      messageStartIndex: 5,
      messageEndIndex: 5,
    },
    {
      id: "p1-err0",
      parentId: "p1-step0",
      name: "Generation error",
      category: "error" as const,
      startMs: 240,
      endMs: 260,
      promptIndex: 1,
      stepIndex: 0,
      status: "error" as const,
      messageStartIndex: 5,
      messageEndIndex: 5,
    },
  ],
};

function openChatTab() {
  fireEvent.click(screen.getByTitle("Chat view"));
}

async function getTraceWaterfallRegion() {
  return screen.findByRole("region", {
    name: /Trace waterfall/i,
  });
}

const originalResizeObserver = global.ResizeObserver;
const originalRequestAnimationFrame = window.requestAnimationFrame;
const originalCancelAnimationFrame = window.cancelAnimationFrame;

class ControlledResizeObserver {
  static instances: ControlledResizeObserver[] = [];

  callback: ResizeObserverCallback;
  observed = new Set<Element>();

  constructor(callback: ResizeObserverCallback) {
    this.callback = callback;
    ControlledResizeObserver.instances.push(this);
  }

  observe = vi.fn((element: Element) => {
    this.observed.add(element);
  });

  unobserve = vi.fn((element: Element) => {
    this.observed.delete(element);
  });

  disconnect = vi.fn(() => {
    this.observed.clear();
  });

  trigger(elements?: Element[]) {
    const targets = (elements ?? Array.from(this.observed)).filter((element) =>
      this.observed.has(element),
    );
    if (targets.length === 0) return;

    this.callback(
      targets.map(
        (target) =>
          ({
            target,
            contentRect: target.getBoundingClientRect(),
            borderBoxSize: [],
            contentBoxSize: [],
            devicePixelContentBoxSize: [],
          }) as ResizeObserverEntry,
      ),
      this as unknown as ResizeObserver,
    );
  }

  static latest() {
    return ControlledResizeObserver.instances[
      ControlledResizeObserver.instances.length - 1
    ];
  }

  static reset() {
    ControlledResizeObserver.instances = [];
  }
}

function installTimerBackedAnimationFrame() {
  vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
    return window.setTimeout(() => callback(performance.now()), 0);
  });
  vi.spyOn(window, "cancelAnimationFrame").mockImplementation((handle) => {
    window.clearTimeout(handle);
  });
}

function mockElementRect(
  element: Element,
  {
    top,
    height,
    left = 0,
    width = 400,
  }: {
    top: number;
    height: number;
    left?: number;
    width?: number;
  },
) {
  Object.defineProperty(element, "getBoundingClientRect", {
    configurable: true,
    value: () => ({
      top,
      bottom: top + height,
      left,
      right: left + width,
      width,
      height,
      x: left,
      y: top,
      toJSON: () => ({}),
    }),
  });
}

function renderInScrollHost(ui: ReactNode) {
  const scrollHost = document.createElement("div");
  scrollHost.setAttribute("data-testid", "trace-scroll-host");
  scrollHost.style.overflowY = "auto";
  document.body.appendChild(scrollHost);

  const root = document.createElement("div");
  scrollHost.appendChild(root);

  const scrollTo = vi.fn();
  Object.defineProperty(scrollHost, "clientHeight", {
    configurable: true,
    value: 200,
  });
  Object.defineProperty(scrollHost, "scrollHeight", {
    configurable: true,
    value: 1200,
  });
  Object.defineProperty(scrollHost, "scrollTop", {
    configurable: true,
    writable: true,
    value: 0,
  });
  Object.defineProperty(scrollHost, "scrollTo", {
    configurable: true,
    value: scrollTo,
  });
  mockElementRect(scrollHost, { top: 100, height: 200 });

  return {
    scrollHost,
    scrollTo,
    ...render(ui, { container: root }),
  };
}

describe("TraceViewer", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
    window.requestAnimationFrame = originalRequestAnimationFrame;
    window.cancelAnimationFrame = originalCancelAnimationFrame;
    global.ResizeObserver = originalResizeObserver;
    ControlledResizeObserver.reset();
    document
      .querySelectorAll('[data-testid="trace-scroll-host"]')
      .forEach((node) => node.remove());
  });

  it("defaults to Timeline tab", async () => {
    render(<TraceViewer trace={simpleTextTrace} estimatedDurationMs={100} />);
    expect(await screen.findByText("Estimated total only")).toBeInTheDocument();
  });

  it("timeline shows no data when no spans and zero estimated duration", async () => {
    render(<TraceViewer trace={simpleTextTrace} estimatedDurationMs={0} />);
    expect(
      await screen.findByText("No timing data recorded for this iteration."),
    ).toBeInTheDocument();
  });

  it("switching Timeline, Chat, and Raw works", async () => {
    render(<TraceViewer trace={simpleTextTrace} estimatedDurationMs={100} />);
    expect(await screen.findByText("Estimated total only")).toBeInTheDocument();
    openChatTab();
    expect(screen.getAllByTestId("message-view").length).toBeGreaterThan(0);
    fireEvent.click(screen.getByTitle("Raw JSON"));
    expect(screen.getByTestId("trace-viewer-raw-json")).toBeInTheDocument();
    expect(screen.getByTestId("json-editor")).toBeInTheDocument();
    fireEvent.click(screen.getByTitle("Timeline"));
    expect(await screen.findByText("Estimated total only")).toBeInTheDocument();
  });

  it("leaves Raw on Escape", async () => {
    render(<TraceViewer trace={simpleTextTrace} estimatedDurationMs={100} />);
    expect(await screen.findByText("Estimated total only")).toBeInTheDocument();
    fireEvent.click(screen.getByTitle("Raw JSON"));
    expect(screen.getByTestId("trace-viewer-raw-json")).toBeInTheDocument();
    fireEvent.keyDown(window, { key: "Escape", bubbles: true });
    expect(await screen.findByText("Estimated total only")).toBeInTheDocument();
    expect(
      screen.queryByTestId("trace-viewer-raw-json"),
    ).not.toBeInTheDocument();
  });

  it("leaves Chat on Escape", async () => {
    render(<TraceViewer trace={simpleTextTrace} estimatedDurationMs={100} />);
    expect(await screen.findByText("Estimated total only")).toBeInTheDocument();
    openChatTab();
    expect(screen.getByTestId("trace-viewer-chat")).toBeInTheDocument();
    fireEvent.keyDown(window, { key: "Escape", bubbles: true });
    expect(await screen.findByText("Estimated total only")).toBeInTheDocument();
    expect(screen.queryByTestId("trace-viewer-chat")).not.toBeInTheDocument();
  });

  it("shows Tools tab when eval tool calls are provided and renders compare view", async () => {
    render(
      <TraceViewer
        trace={simpleTextTrace}
        estimatedDurationMs={100}
        expectedToolCalls={[{ toolName: "a", arguments: {} }]}
        actualToolCalls={[{ toolName: "b", arguments: { x: 1 } }]}
      />,
    );
    expect(
      await screen.findByTestId("trace-viewer-tools-tab"),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("trace-viewer-tools-tab"));
    expect(
      screen.getByTestId("trace-viewer-tools-compare"),
    ).toBeInTheDocument();
    expect(screen.getByText("Expected")).toBeInTheDocument();
    expect(screen.getByText("Actual")).toBeInTheDocument();
  });

  it("hides Tools tab when there are no expected or actual tool calls", async () => {
    render(<TraceViewer trace={simpleTextTrace} estimatedDurationMs={100} />);
    expect(await screen.findByText("Estimated total only")).toBeInTheDocument();
    expect(
      screen.queryByTestId("trace-viewer-tools-tab"),
    ).not.toBeInTheDocument();
  });

  it("recorded spans show timeline toolbar instead of estimated-only banner", async () => {
    render(
      <TraceViewer
        trace={{
          traceVersion: 1,
          messages: simpleTextTrace.messages,
          spans: [
            {
              id: "a",
              name: "Step 1",
              category: "step",
              startMs: 0,
              endMs: 50,
            },
          ],
        }}
        estimatedDurationMs={99_999}
      />,
    );
    expect(
      await screen.findByRole("button", { name: /Filter timeline rows: All/ }),
    ).toBeInTheDocument();
    expect(screen.queryByText("Estimated total only")).not.toBeInTheDocument();
  });

  it("renders traceInsight under the toolbar when provided", async () => {
    render(
      <TraceViewer
        trace={{
          traceVersion: 1,
          messages: simpleTextTrace.messages,
          spans: [
            {
              id: "a",
              name: "Step 1",
              category: "step",
              startMs: 0,
              endMs: 50,
            },
          ],
        }}
        traceInsight={<span>Insight caption text</span>}
      />,
    );
    expect(
      await screen.findByRole("button", { name: /Filter timeline rows: All/ }),
    ).toBeInTheDocument();
    const slot = screen.getByTestId("trace-viewer-insight-slot");
    expect(within(slot).getByText("Insight caption text")).toBeInTheDocument();
  });

  it("renders prompt-grouped waterfall rows with detail pane", async () => {
    render(<TraceViewer trace={waterfallTrace} />);

    // Prompt rows show user message as primary label, with "Prompt N" in subtitle
    expect(
      (await screen.findAllByText(/User: "Need docs"/)).length,
    ).toBeGreaterThan(0);
    expect(screen.getAllByText(/User: "Summarize it"/).length).toBeGreaterThan(
      0,
    );
    expect(screen.getByTestId("trace-detail-pane")).toBeInTheDocument();

    const waterfall = await getTraceWaterfallRegion();
    expect(
      within(waterfall).getByRole("button", { name: /Tool · read_docs/i }),
    ).toBeInTheDocument();
    await waitFor(() => {
      const rows = screen.getAllByTestId("trace-row");
      // Generic span name "LLM" renders as label "Agent" (not "LLM ·")
      const llmRows = rows.filter((el) => el.textContent?.includes("Agent"));
      expect(llmRows.length).toBeGreaterThanOrEqual(2);
    });

    fireEvent.click(
      within(waterfall).getByRole("button", { name: /Tool · read_docs/i }),
    );
    const detail = screen.getByTestId("trace-detail-pane");
    expect(within(detail).queryByRole("tablist")).not.toBeInTheDocument();
    expect(within(detail).getByText("Input")).toBeInTheDocument();
    expect(within(detail).getByText("Output")).toBeInTheDocument();
  });

  it("filters the waterfall to tool rows while preserving step context", async () => {
    const user = userEvent.setup();
    render(<TraceViewer trace={waterfallTrace} />);

    expect(await screen.findByText("Generation error")).toBeInTheDocument();

    await user.click(
      screen.getByRole("button", { name: /Filter timeline rows/ }),
    );
    await user.click(
      await screen.findByRole("menuitemradio", { name: "Tool" }),
    );

    const waterfall = await getTraceWaterfallRegion();
    expect(
      within(waterfall).getByRole("button", { name: /Tool · read_docs/i }),
    ).toBeInTheDocument();
    expect(screen.queryByText("Generation error")).not.toBeInTheDocument();
    expect(screen.getAllByText(/User: "Need docs"/).length).toBeGreaterThan(0);
  });

  it("does not render a reset button in the recorded trace toolbar", async () => {
    const user = userEvent.setup();
    render(<TraceViewer trace={waterfallTrace} />);

    expect(await screen.findByText("Generation error")).toBeInTheDocument();
    await user.click(
      screen.getByRole("button", { name: /Filter timeline rows/ }),
    );
    await user.click(
      await screen.findByRole("menuitemradio", { name: "Tool" }),
    );
    expect(screen.queryByText("Generation error")).not.toBeInTheDocument();

    expect(
      screen.queryByRole("button", { name: "Reset trace view" }),
    ).not.toBeInTheDocument();
  });

  it("selects waterfall rows with arrow keys on the timeline region", async () => {
    render(<TraceViewer trace={waterfallTrace} />);
    const region = await getTraceWaterfallRegion();
    await within(region).findByRole("button", { name: /Tool · read_docs/i });
    region.focus();

    const selectedLabel = () =>
      screen
        .getAllByTestId("trace-row")
        .find((el) => el.getAttribute("data-state") === "selected")
        ?.textContent ?? "";

    const first = selectedLabel();
    expect(first).toContain('User: "Need docs"');

    fireEvent.keyDown(region, { key: "ArrowDown" });
    expect(selectedLabel()).not.toBe(first);

    fireEvent.keyDown(region, { key: "ArrowUp" });
    expect(selectedLabel()).toBe(first);
  });

  it("reveals prompt rows at the exact user message", async () => {
    const { scrollTo } = renderInScrollHost(
      <TraceViewer trace={waterfallTrace} />,
    );

    vi.useFakeTimers();
    installTimerBackedAnimationFrame();
    fireEvent.click(screen.getByRole("button", { name: "Reveal in Chat" }));

    expect(screen.getAllByTestId("message-view").length).toBeGreaterThan(0);
    const focusedUserMessage = document.querySelector(
      '[data-source-range="0-0"]',
    ) as HTMLElement | null;
    const nonTargetMessage = document.querySelector(
      '[data-source-range="1-2"]',
    ) as HTMLElement | null;

    expect(focusedUserMessage?.className).toContain("bg-primary/5");
    expect(nonTargetMessage?.className ?? "").not.toContain("bg-primary/5");

    mockElementRect(focusedUserMessage!, { top: 520, height: 40 });
    act(() => {
      vi.advanceTimersByTime(0);
    });

    expect(scrollTo).toHaveBeenCalledWith(
      expect.objectContaining({
        top: 340,
        behavior: "smooth",
      }),
    );
  });

  it("calls onRevealNavigateToChat when forced view mode blocks switching to chat", async () => {
    const onRevealNavigateToChat = vi.fn();
    render(
      <TraceViewer
        trace={waterfallTrace}
        forcedViewMode="timeline"
        onRevealNavigateToChat={onRevealNavigateToChat}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Reveal in Chat" }));

    expect(onRevealNavigateToChat).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId("trace-viewer-chat")).not.toBeInTheDocument();
  });

  it("reveals a selected timeline row in chat view", async () => {
    const { scrollTo } = renderInScrollHost(
      <TraceViewer trace={waterfallTrace} />,
    );

    const waterfall = await getTraceWaterfallRegion();
    vi.useFakeTimers();
    installTimerBackedAnimationFrame();
    fireEvent.click(
      within(waterfall).getByRole("button", { name: /Tool · read_docs/i }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Reveal in Chat" }));

    expect(screen.getAllByTestId("message-view").length).toBeGreaterThan(0);
    const focusedMessage = document.querySelector(
      '[data-source-range="1-2"]',
    ) as HTMLElement | null;
    expect(focusedMessage?.className).toContain("bg-primary/5");
    expect(focusedMessage).not.toBeNull();

    mockElementRect(focusedMessage!, { top: 520, height: 40 });
    act(() => {
      vi.advanceTimersByTime(0);
    });

    expect(scrollTo).toHaveBeenCalledWith(
      expect.objectContaining({
        top: 340,
        behavior: "smooth",
      }),
    );
  });

  it("re-scrolls after resize events until chat layout settles", async () => {
    const { scrollTo } = renderInScrollHost(
      <TraceViewer trace={waterfallTrace} />,
    );

    const waterfall = await getTraceWaterfallRegion();
    vi.useFakeTimers();
    installTimerBackedAnimationFrame();
    global.ResizeObserver =
      ControlledResizeObserver as unknown as typeof ResizeObserver;
    fireEvent.click(
      within(waterfall).getByRole("button", { name: /Tool · read_docs/i }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Reveal in Chat" }));

    const focusedMessage = document.querySelector(
      '[data-source-range="1-2"]',
    ) as HTMLElement | null;
    expect(focusedMessage).not.toBeNull();
    mockElementRect(focusedMessage!, { top: 520, height: 40 });

    act(() => {
      vi.advanceTimersByTime(0);
    });

    expect(scrollTo).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        top: 340,
        behavior: "smooth",
      }),
    );

    const resizeObserver = ControlledResizeObserver.latest();
    expect(resizeObserver).toBeDefined();

    mockElementRect(focusedMessage!, { top: 260, height: 40 });
    act(() => {
      resizeObserver?.trigger([focusedMessage!]);
      vi.advanceTimersByTime(0);
    });

    expect(scrollTo).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        top: 80,
        behavior: "auto",
      }),
    );

    act(() => {
      vi.advanceTimersByTime(120);
    });
    act(() => {
      vi.runOnlyPendingTimers();
    });

    expect(scrollTo).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({
        top: 80,
        behavior: "auto",
      }),
    );

    act(() => {
      vi.advanceTimersByTime(2000);
    });

    expect(scrollTo).toHaveBeenCalledTimes(3);
  });

  it("top-anchors tall revealed blocks in trace chat view", async () => {
    const { scrollTo } = renderInScrollHost(
      <TraceViewer trace={waterfallTrace} />,
    );

    const waterfall = await getTraceWaterfallRegion();
    vi.useFakeTimers();
    installTimerBackedAnimationFrame();
    fireEvent.click(
      within(waterfall).getByRole("button", { name: /Tool · read_docs/i }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Reveal in Chat" }));

    const focusedMessage = document.querySelector(
      '[data-source-range="1-2"]',
    ) as HTMLElement | null;
    expect(focusedMessage).not.toBeNull();
    mockElementRect(focusedMessage!, { top: 520, height: 120 });

    act(() => {
      vi.advanceTimersByTime(0);
    });

    expect(scrollTo).toHaveBeenCalledWith(
      expect.objectContaining({
        top: 404,
        behavior: "smooth",
      }),
    );
    expect(screen.getByTestId("transcript-focus-guide")).toBeInTheDocument();
  });

  it("legacy trace without spans shows Estimated total only", async () => {
    render(<TraceViewer trace={simpleTextTrace} estimatedDurationMs={250} />);
    expect(await screen.findByText("Estimated total only")).toBeInTheDocument();
    expect(
      await screen.findByText("Per-step timing was not recorded for this run."),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/Conversation detail is in the Chat tab/i),
    ).toBeInTheDocument();
    expect(screen.getByText(/confirm whether a/i)).toBeInTheDocument();
  });

  it("legacy estimated timeline omits transcript hint when there are no messages", async () => {
    render(
      <TraceViewer
        trace={{ traceVersion: 1 as const, messages: [] }}
        estimatedDurationMs={40}
      />,
    );
    expect(await screen.findByText("Estimated total only")).toBeInTheDocument();
    expect(
      screen.queryByText(/Conversation detail is in the Chat tab/i),
    ).not.toBeInTheDocument();
  });

  it("Raw tab exposes blob JSON so spans presence can be verified", () => {
    render(<TraceViewer trace={simpleTextTrace} estimatedDurationMs={100} />);
    fireEvent.click(screen.getByTitle("Raw JSON"));
    const raw = screen.getByTestId("json-editor").textContent ?? "";
    expect(raw).toContain('"messages"');
    expect(raw).not.toContain('"spans"');
  });

  it("timeline with spans but no messages still renders; Chat is empty", async () => {
    render(
      <TraceViewer
        trace={{
          traceVersion: 1,
          messages: [],
          spans: [
            {
              id: "s1",
              name: "Step 1",
              category: "step",
              startMs: 0,
              endMs: 10,
            },
          ],
        }}
      />,
    );
    expect(
      await screen.findByRole("button", { name: /Filter timeline rows: All/ }),
    ).toBeInTheDocument();
    openChatTab();
    expect(screen.getByText("No messages in trace")).toBeInTheDocument();
    fireEvent.click(screen.getByTitle("Raw JSON"));
    expect(screen.getByTestId("json-editor").textContent).toContain("spans");
  });

  // --- Widget snapshot replay ---

  it("renders MCP App replay from stored widget snapshots", () => {
    render(<TraceViewer trace={widgetSnapshotTrace} />);
    openChatTab();

    expect(mockMessageView).toHaveBeenCalled();
    const props = mockMessageView.mock.calls[0][0];
    const overrides = props.toolRenderOverrides as Record<string, any>;
    expect(overrides["call-1"]).toBeDefined();
    expect(overrides["call-1"].cachedWidgetHtmlUrl).toBe(
      "https://storage.example.com/widget.html",
    );
    expect(overrides["call-1"].isOffline).toBe(true);
  });

  it("falls back to live widget metadata for legacy traces", () => {
    render(
      <TraceViewer
        trace={toolTrace}
        toolsMetadata={{
          create_view: {
            ui: { resourceUri: "ui://widget/create-view.html" },
          },
        }}
        toolServerMap={{ create_view: "server-1" }}
      />,
    );
    openChatTab();

    expect(mockMessageView).toHaveBeenCalled();
    const props = mockMessageView.mock.calls[0][0];
    const overrides = props.toolRenderOverrides as Record<string, any>;
    expect(overrides["call-1"]?.cachedWidgetHtmlUrl).toBeUndefined();
  });

  // --- Chat mode ---

  it("chat tab renders MessageView entries", () => {
    render(<TraceViewer trace={simpleTextTrace} />);
    openChatTab();

    const messageViews = screen.getAllByTestId("message-view");
    expect(messageViews.length).toBeGreaterThanOrEqual(1);
    expect(mockMessageView).toHaveBeenCalled();

    const firstCall = mockMessageView.mock.calls[0][0];
    expect(firstCall.message).toBeDefined();
    expect(firstCall.message.parts).toBeDefined();
  });

  it("raw mode shows original blob via JsonEditor", () => {
    render(<TraceViewer trace={simpleTextTrace} />);

    fireEvent.click(screen.getByTitle("Raw JSON"));
    expect(screen.getByTestId("json-editor")).toBeDefined();
    expect(screen.getByTestId("json-editor").textContent).toContain("Hello");
  });

  it("raw mode uses auto-height JSON so the parent pane scrolls", () => {
    render(<TraceViewer trace={simpleTextTrace} />);

    fireEvent.click(screen.getByTitle("Raw JSON"));

    expect(mockJsonEditor).toHaveBeenCalledWith(
      expect.objectContaining({
        height: "auto",
        viewOnly: true,
        value: simpleTextTrace,
      }),
    );
  });

  // --- Props pass-through ---

  it("passes minimalMode={true} and interactive={false} to MessageView", () => {
    render(<TraceViewer trace={simpleTextTrace} />);
    openChatTab();

    expect(mockMessageView).toHaveBeenCalledWith(
      expect.objectContaining({
        minimalMode: true,
        interactive: false,
      }),
    );
  });

  it("requests collapsed reasoning rendering in chat trace mode", () => {
    render(<TraceViewer trace={reasoningTrace} />);
    openChatTab();

    expect(mockMessageView).toHaveBeenCalledWith(
      expect.objectContaining({
        reasoningDisplayMode: "collapsed",
      }),
    );
  });

  it("forwards ModelDefinition when provided", () => {
    const model = {
      id: "gpt-4o",
      name: "GPT-4o",
      provider: "openai" as const,
    };
    render(<TraceViewer trace={simpleTextTrace} model={model} />);
    openChatTab();

    expect(mockMessageView).toHaveBeenCalledWith(
      expect.objectContaining({
        model: expect.objectContaining({
          id: "gpt-4o",
          name: "GPT-4o",
          provider: "openai",
        }),
      }),
    );
  });

  it("uses fallback ModelDefinition when model prop is omitted", () => {
    render(<TraceViewer trace={simpleTextTrace} />);
    openChatTab();

    expect(mockMessageView).toHaveBeenCalledWith(
      expect.objectContaining({
        model: expect.objectContaining({
          id: "unknown",
          name: "Unknown",
          provider: "custom",
        }),
      }),
    );
  });

  // --- Widget fallback ---

  it("scrubs widget when no connected server and no snapshot widgetHtmlUrl", () => {
    const widgetToolTrace = {
      messages: [
        {
          role: "assistant",
          content: [
            {
              type: "tool-call",
              toolCallId: "call-w",
              toolName: "widget_tool",
              input: {},
            },
          ],
        },
        {
          role: "tool",
          content: [
            {
              type: "tool-result",
              toolCallId: "call-w",
              toolName: "widget_tool",
              output: { type: "json", value: { data: "result" } },
            },
          ],
        },
      ],
    };

    render(
      <TraceViewer
        trace={widgetToolTrace}
        toolsMetadata={{
          widget_tool: { ui: { resourceUri: "ui://test/widget.html" } },
        }}
      />,
    );
    openChatTab();

    expect(mockMessageView).toHaveBeenCalled();
    const props = mockMessageView.mock.calls[0][0];
    const overrides = props.toolRenderOverrides as Record<string, any>;
    expect(overrides["call-w"]).toBeDefined();
    expect(overrides["call-w"].toolMetadata).toEqual({});
    expect(overrides["call-w"].cachedWidgetHtmlUrl).toBeUndefined();
  });

  it("uses live widget replay when connected server matches", () => {
    render(
      <TraceViewer
        trace={toolTrace}
        toolsMetadata={{
          create_view: { ui: { resourceUri: "ui://widget/create-view.html" } },
        }}
        toolServerMap={{ create_view: "server-1" }}
        connectedServerIds={["server-1"]}
      />,
    );
    openChatTab();

    expect(mockMessageView).toHaveBeenCalled();
    const props = mockMessageView.mock.calls[0][0];
    const overrides = props.toolRenderOverrides as Record<string, any>;
    expect(overrides["call-1"]).toBeUndefined();
  });

  it("does not wire action handlers when interactive={false}", () => {
    render(<TraceViewer trace={toolTrace} />);
    openChatTab();

    const lastCall = mockMessageView.mock.calls[0][0];
    expect(lastCall.interactive).toBe(false);
    expect(lastCall.minimalMode).toBe(true);
  });
});
