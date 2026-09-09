/**
 * The three-panel workspace: tools on the left, the page in the center,
 * activity as logs on the right.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import type { ReactNode } from "react";
import { render, screen, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { WebmcpInspectorTab } from "../WebmcpInspectorTab";
import { useWebmcpInspectorStore } from "@/stores/webmcp-inspector-store";
import type {
  WebMcpActivityEntry,
  WebMcpSessionPublic,
  WebMcpToolDescriptor,
} from "@/shared/webmcp-inspector-protocol";

vi.mock("@/components/ui/resizable", () => ({
  ResizablePanelGroup: ({ children }: { children?: ReactNode }) => (
    <div data-testid="resizable-panel-group">{children}</div>
  ),
  ResizablePanel: ({ children }: { children?: ReactNode }) => (
    <div data-testid="resizable-panel">{children}</div>
  ),
  ResizableHandle: () => <div data-testid="resizable-handle" />,
}));

class FakeEventSource {
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  close() {}
}
vi.stubGlobal("EventSource", FakeEventSource as never);

const SESSION: WebMcpSessionPublic = {
  sessionId: "session-layout",
  status: "ready",
  url: "https://pizza.test/",
  createdAt: 1_000,
  expiresAt: 2_000,
  hardExpiresAt: 3_000,
  viewportTransport: { kind: "native-window" },
  protocolVersion: 1,
};

const TOOL: WebMcpToolDescriptor = {
  toolKey: "https://pizza.test::add_topping",
  name: "add_topping",
  origin: "https://pizza.test",
  fromSubframe: false,
  description: "Add one or more toppings to the pizza",
  registrationKind: "imperative",
  inputSchema: {
    type: "object",
    properties: {
      topping: { type: "string", description: "Topping to add" },
    },
  },
};

const ACTIVITY: WebMcpActivityEntry[] = [
  { id: "a0", ts: 1_000, kind: "session_started", url: "https://pizza.test/" },
  {
    id: "a1",
    ts: 1_100,
    kind: "invocation_settled",
    toolKey: TOOL.toolKey,
    invokeId: "inv-1",
    source: "manual",
    state: "succeeded",
    durationMs: 42,
    output: "Added 1 topping",
  },
];

describe("WebmcpInspectorTab — three-panel workspace", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    useWebmcpInspectorStore.setState({
      session: SESSION,
      tools: [TOOL],
      activity: ACTIVITY,
      pending: [],
      starting: false,
      error: undefined,
      lastScreenshot: undefined,
      liveFrame: undefined,
      chatEnabled: false,
    });
  });

  it("lists tools on the left, the page in the center, and activity as logs", () => {
    render(<WebmcpInspectorTab />);

    expect(screen.getByLabelText("Page URL to inspect")).toBeInTheDocument();
    expect(screen.getByText("add_topping")).toBeInTheDocument();
    expect(screen.queryByText("Open a page")).toBeNull();
    expect(
      screen.getByText(/A live view of the page. Interact with it in the browser window/),
    ).toBeInTheDocument();
    expect(screen.getByPlaceholderText("Search logs")).toBeInTheDocument();
    expect(screen.getByText("sess")).toBeInTheDocument();
    expect(screen.getByText("res")).toBeInTheDocument();
  });

  it("expands an activity row from the log rail", () => {
    render(<WebmcpInspectorTab />);
    fireEvent.click(screen.getByText("https://pizza.test/"));
    expect(screen.getByText(/"kind": "session_started"/)).toBeInTheDocument();
  });

  it("swaps the left list for the invoke form without leaving the page", () => {
    render(<WebmcpInspectorTab />);
    fireEvent.click(
      screen.getByRole("button", { name: /Add one or more toppings/i }),
    );

    expect(screen.getByRole("button", { name: "Invoke" })).toBeInTheDocument();
    expect(screen.getByText("Parameters")).toBeInTheDocument();
    expect(
      screen.getByText(/Interact with it in the browser window/),
    ).toBeInTheDocument();
    expect(screen.getByPlaceholderText("Search logs")).toBeInTheDocument();
  });

  it("shows an empty center until a page is opened", () => {
    useWebmcpInspectorStore.setState({
      session: undefined,
      tools: [],
      activity: [],
    });
    render(<WebmcpInspectorTab />);
    expect(screen.getByText("Open a page")).toBeInTheDocument();
    expect(
      screen.getByText(/Enter a URL on the left to inspect the tools it registers/),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Open browser" })).toBeInTheDocument();
  });

  it("switches between two tools that share a name by identity", async () => {
    const user = userEvent.setup();
    const frameTool: WebMcpToolDescriptor = {
      ...TOOL,
      toolKey: "https://checkout.test::add_topping",
      origin: "https://checkout.test",
      description: "Add a topping from checkout",
    };
    useWebmcpInspectorStore.setState({ tools: [TOOL, frameTool] });
    render(<WebmcpInspectorTab />);

    await user.click(
      screen.getByRole("button", { name: /Add one or more toppings/i }),
    );
    expect(screen.getByText("https://pizza.test")).toBeInTheDocument();

    await user.click(screen.getByTitle("Switch tool"));
    await user.click(screen.getByText("https://checkout.test"));

    expect(screen.getByText("https://checkout.test")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Description" }));
    expect(screen.getByText("Add a topping from checkout")).toBeInTheDocument();
  });
});
