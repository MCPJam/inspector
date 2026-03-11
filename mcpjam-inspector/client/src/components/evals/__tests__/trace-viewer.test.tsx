import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
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

describe("TraceViewer", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // --- Widget snapshot replay ---

  it("renders MCP App replay from stored widget snapshots", () => {
    render(<TraceViewer trace={widgetSnapshotTrace} />);

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

    expect(mockMessageView).toHaveBeenCalled();
    const props = mockMessageView.mock.calls[0][0];
    const overrides = props.toolRenderOverrides as Record<string, any>;
    // No snapshot with widgetHtmlUrl and no connected servers → widget scrubbed, no replay override with cachedWidgetHtmlUrl
    expect(overrides["call-1"]?.cachedWidgetHtmlUrl).toBeUndefined();
  });

  // --- Formatted / Raw mode ---

  it("formatted mode renders MessageView entries", () => {
    render(<TraceViewer trace={simpleTextTrace} />);

    const messageViews = screen.getAllByTestId("message-view");
    expect(messageViews.length).toBeGreaterThanOrEqual(1);
    expect(mockMessageView).toHaveBeenCalled();

    const firstCall = mockMessageView.mock.calls[0][0];
    expect(firstCall.message).toBeDefined();
    expect(firstCall.message.parts).toBeDefined();
  });

  it("raw mode shows original blob via JsonEditor", () => {
    render(<TraceViewer trace={simpleTextTrace} />);

    fireEvent.click(screen.getByTitle("Raw JSON view"));
    expect(screen.getByTestId("json-editor")).toBeDefined();
    expect(screen.getByTestId("json-editor").textContent).toContain("Hello");
  });

  // --- Props pass-through ---

  it("passes minimalMode={true} and interactive={false} to MessageView", () => {
    render(<TraceViewer trace={simpleTextTrace} />);

    expect(mockMessageView).toHaveBeenCalledWith(
      expect.objectContaining({
        minimalMode: true,
        interactive: false,
      }),
    );
  });

  it("requests collapsed reasoning rendering in formatted trace mode", () => {
    render(<TraceViewer trace={reasoningTrace} />);

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

    expect(mockMessageView).toHaveBeenCalled();
    const props = mockMessageView.mock.calls[0][0];
    const overrides = props.toolRenderOverrides as Record<string, any>;
    // Widget is scrubbed — override has empty toolMetadata, no cachedWidgetHtmlUrl
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

    expect(mockMessageView).toHaveBeenCalled();
    const props = mockMessageView.mock.calls[0][0];
    const overrides = props.toolRenderOverrides as Record<string, any>;
    // Live replay — no override needed (PartSwitch resolves from live metadata)
    expect(overrides["call-1"]).toBeUndefined();
  });

  // --- interactive={false} verification ---

  it("does not wire action handlers when interactive={false}", () => {
    render(<TraceViewer trace={toolTrace} />);

    const lastCall = mockMessageView.mock.calls[0][0];
    expect(lastCall.interactive).toBe(false);
    expect(lastCall.minimalMode).toBe(true);
  });
});
