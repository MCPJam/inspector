import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { TraceViewer } from "../trace-viewer";

const { mockMessageView } = vi.hoisted(() => ({
  mockMessageView: vi.fn(),
}));

vi.mock("@/stores/preferences/preferences-provider", () => ({
  usePreferencesStore: (selector: (state: { themeMode: string }) => unknown) =>
    selector({ themeMode: "light" }),
}));

vi.mock("@/lib/provider-logos", () => ({
  getProviderLogo: () => null,
}));

vi.mock("@/components/ui/json-editor", () => ({
  JsonEditor: ({ value }: { value: unknown }) => (
    <div data-testid="json-editor">{JSON.stringify(value)}</div>
  ),
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
      endMs: 40,
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

describe("TraceViewer", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("defaults to Timeline tab", () => {
    render(<TraceViewer trace={simpleTextTrace} estimatedDurationMs={100} />);
    expect(screen.getByText("Estimated total only")).toBeInTheDocument();
  });

  it("timeline shows no data when no spans and zero estimated duration", () => {
    render(
      <TraceViewer trace={simpleTextTrace} estimatedDurationMs={0} />,
    );
    expect(
      screen.getByText("No timing data recorded for this iteration."),
    ).toBeInTheDocument();
  });

  it("switching Timeline, Chat, and Raw works", () => {
    render(<TraceViewer trace={simpleTextTrace} estimatedDurationMs={100} />);
    expect(screen.getByText("Estimated total only")).toBeInTheDocument();
    openChatTab();
    expect(screen.getAllByTestId("message-view").length).toBeGreaterThan(0);
    fireEvent.click(screen.getByTitle("Raw JSON"));
    expect(screen.getByTestId("json-editor")).toBeInTheDocument();
    fireEvent.click(screen.getByTitle("Timeline"));
    expect(screen.getByText("Estimated total only")).toBeInTheDocument();
  });

  it("recorded spans show Recorded timing badge", () => {
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
    expect(screen.getByText("Recorded timing")).toBeInTheDocument();
    expect(screen.queryByText("Estimated total only")).not.toBeInTheDocument();
  });

  it("renders prompt-grouped waterfall rows with detail pane", () => {
    render(<TraceViewer trace={waterfallTrace} />);

    expect(screen.getAllByText("Prompt 1").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Prompt 2").length).toBeGreaterThan(0);
    expect(screen.getByTestId("trace-detail-pane")).toBeInTheDocument();

    expect(screen.getByText(/Tool · read_docs/)).toBeInTheDocument();
    expect(screen.getAllByText("Model response").length).toBeGreaterThanOrEqual(2);
    expect(screen.getAllByText("Prompt 2 · Step 1").length).toBeGreaterThan(0);

    fireEvent.click(screen.getByText(/Tool · read_docs/));
    expect(screen.getByRole("tab", { name: "Input" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Output" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Transcript" })).toBeInTheDocument();
  });

  it("filters the waterfall to tool rows while preserving step context", () => {
    render(<TraceViewer trace={waterfallTrace} />);

    expect(screen.getByText("Generation error")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "TOOL" }));

    expect(screen.getByText(/Tool · read_docs/)).toBeInTheDocument();
    expect(screen.queryByText("Generation error")).not.toBeInTheDocument();
    expect(screen.getAllByText("Prompt 1").length).toBeGreaterThan(0);
  });

  it("reveals a selected timeline row in chat view", async () => {
    const user = userEvent.setup();
    render(<TraceViewer trace={waterfallTrace} />);

    await user.click(screen.getAllByText(/Tool · read_docs/)[0]!);
    await user.click(screen.getByRole("tab", { name: "Transcript" }));
    await user.click(
      screen.getByRole("button", { name: "Reveal in transcript" }),
    );

    expect(screen.getAllByTestId("message-view").length).toBeGreaterThan(0);
    const focusedMessage = document.querySelector('[data-source-range="1-2"]');
    expect(focusedMessage?.className).toContain("bg-primary/5");
  });

  it("legacy trace without spans shows Estimated total only", () => {
    render(<TraceViewer trace={simpleTextTrace} estimatedDurationMs={250} />);
    expect(screen.getByText("Estimated total only")).toBeInTheDocument();
    expect(
      screen.getByText("Per-step timing was not recorded for this run."),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/Conversation detail is in the Chat tab/i),
    ).toBeInTheDocument();
    expect(screen.getByText(/confirm whether a/i)).toBeInTheDocument();
  });

  it("legacy estimated timeline omits transcript hint when there are no messages", () => {
    render(
      <TraceViewer
        trace={{ traceVersion: 1 as const, messages: [] }}
        estimatedDurationMs={40}
      />,
    );
    expect(screen.getByText("Estimated total only")).toBeInTheDocument();
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

  it("timeline with spans but no messages still renders; Chat is empty", () => {
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
    expect(screen.getByText("Recorded timing")).toBeInTheDocument();
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
