/**
 * The Events tab (MCP Events draft extension) in LOCAL mode: the catalog
 * list and selected event type, the subscribe form, the client it subscribes
 * as, the local webhook acknowledgement, the SSE feed
 * (`/api/mcp/events/stream` frames) including untrusted event data, and the
 * spec's subscription states.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import type { MCPServerConfig } from "@mcpjam/sdk/browser";
import { MemoryRouter, Route, Routes } from "react-router";
import type {
  EventsListResponse,
  EventsSubscriptionView,
} from "@/shared/events-api";

const mockLoadEventsCatalog = vi.fn();
const mockWatchEventsCatalog =
  vi.fn<
    (
      serverName: string,
      signal: AbortSignal,
      onChange: () => void,
    ) => Promise<void>
  >();
const mockListLocal = vi.fn();
const mockCreateLocal = vi.fn();
const mockSetLocalState = vi.fn();
const mockTrack = vi.fn();

vi.mock("@/lib/apis/mcp-events-api", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  loadEventsCatalog: (...args: unknown[]) => mockLoadEventsCatalog(...args),
  watchEventsCatalog: (...args: Parameters<typeof mockWatchEventsCatalog>) =>
    mockWatchEventsCatalog(...args),
  listLocalEventSubscriptions: (...args: unknown[]) => mockListLocal(...args),
  createLocalEventSubscription: (...args: unknown[]) =>
    mockCreateLocal(...args),
  setLocalEventSubscriptionState: (...args: unknown[]) =>
    mockSetLocalState(...args),
  rotateLocalEventSubscriptionSecret: vi.fn(),
  fetchLocalEventsFeed: vi
    .fn()
    .mockResolvedValue({ entries: [], nextAfter: 0 }),
  localEventsStreamUrl: (after: number, projectId: string | null) =>
    `/api/mcp/events/stream?after=${after}${projectId ? `&projectId=${projectId}` : ""}`,
}));

vi.mock("@/hooks/useClients", () => ({
  useHostList: () => ({
    hosts: [
      {
        hostId: "host_chatgpt",
        name: "ChatGPT",
        hostStyle: "chatgpt",
        eventDeliveryModes: ["webhook"],
        hostConfigId: "cfg_1",
        modelId: "openai/gpt-5",
        serverCount: 1,
        createdAt: 0,
        updatedAt: 0,
      },
    ],
    isLoading: false,
  }),
}));

vi.mock("convex/react", () => ({
  useConvexAuth: () => ({ isAuthenticated: false, isLoading: false }),
  useQuery: () => undefined,
  useMutation: () => vi.fn(),
}));

vi.mock("@/lib/analytics", () => ({
  track: (...args: unknown[]) => mockTrack(...args),
}));

vi.mock("../ui/three-panel-layout", () => ({
  ThreePanelLayout: ({
    sidebar,
    content,
    mobileNavigation,
  }: {
    sidebar: React.ReactNode;
    content: React.ReactNode;
    mobileNavigation: { selectionKey: string; onBack: () => void };
  }) => (
    <div>
      <div data-testid="events-sidebar">{sidebar}</div>
      <div data-testid="events-content">{content}</div>
      <button onClick={mobileNavigation.onBack}>Back to catalog</button>
      <span data-testid="mobile-selection">
        {mobileNavigation.selectionKey}
      </span>
    </div>
  ),
}));

vi.mock("@/components/ui/json-editor", () => ({
  JsonEditor: (props: { value: unknown }) => (
    <div data-testid="json-editor">{JSON.stringify(props.value)}</div>
  ),
  ScrollableJsonView: (props: { value: unknown }) => (
    <div data-testid="json-view">{JSON.stringify(props.value)}</div>
  ),
}));

import { EventsTab } from "../EventsTab";
import { useTrafficLogStore } from "@/stores/traffic-log-store";

const SERVER = "github";

const serverConfig = () =>
  ({
    transportType: "stdio",
    command: "node",
    args: ["server.js"],
  }) as MCPServerConfig;

/** jsdom has no EventSource. */
class FakeEventSource {
  static instances: FakeEventSource[] = [];
  onmessage: ((ev: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  onopen: (() => void) | null = null;
  closed = false;
  constructor(public readonly url: string) {
    FakeEventSource.instances.push(this);
  }
  addEventListener() {}
  close() {
    this.closed = true;
  }
}

function emitFrame(frame: unknown) {
  act(() => {
    for (const source of FakeEventSource.instances) {
      if (!source.closed) source.onmessage?.({ data: JSON.stringify(frame) });
    }
  });
}

const declaredSupport = {
  handshakeObserved: true,
  declared: true,
  listChanged: false,
  source: "initialize" as const,
  capability: {},
};

function catalog(
  events: EventsListResponse["events"],
  overrides: Partial<EventsListResponse> = {},
): EventsListResponse {
  return {
    events,
    support: declaredSupport,
    rawCapabilities: { events: {}, tools: {} },
    protocolVersion: "2026-07-28",
    ...overrides,
  };
}

const issueCreated = {
  name: "issue.created",
  description: "A new issue was opened",
  delivery: ["poll", "push", "webhook"],
  inputSchema: {
    type: "object",
    properties: { repo: { type: "string", description: "owner/name" } },
    required: ["repo"],
  },
  payloadSchema: {
    type: "object",
    properties: { title: { type: "string", default: "Example" } },
  },
};

const subscriptionView = (
  overrides: Partial<EventsSubscriptionView> = {},
): EventsSubscriptionView => ({
  id: "esub_1",
  serverId: SERVER,
  eventName: "issue.created",
  arguments: { repo: "octo/hello" },
  mode: "webhook",
  profile: "draft@28ec35e",
  desiredState: "active",
  observedState: "active",
  generation: 2,
  refreshBefore: Date.now() + 5 * 60_000,
  callbackUrl: "http://localhost:6274/api/mcp/events/hooks/i/inb/s/slot",
  serverSubscriptionId: "srv-sub-1",
  consecutiveFailures: 0,
  locality: "local",
  ...overrides,
});

function renderTab() {
  return render(
    <EventsTab serverConfig={serverConfig()} serverName={SERVER} />,
  );
}

/** Selecting an event opens its subscription form inline. */
async function openEventType(name: string) {
  fireEvent.click(await screen.findByRole("tab", { name: /^Events/ }));
  const list = await screen.findByTestId("event-types");
  fireEvent.click(within(list).getByRole("button", { name: new RegExp(name) }));
  return screen.findByRole("tabpanel", { name: "Subscribe" });
}

async function openWorkspaceView(
  name: "Subscribe" | "Occurrences" | "Subscriptions" | "Event type details",
) {
  const tab =
    name === "Subscribe" || name === "Event type details" ? "Events" : name;
  fireEvent.click(screen.getByRole("tab", { name: new RegExp(`^${tab}`) }));
  if (name === "Event type details") {
    fireEvent.click(
      screen.getByRole("button", { name: "Event type details", exact: true }),
    );
  } else if (name === "Subscriptions") {
    const list = await screen.findByTestId("subscription-list");
    fireEvent.click(within(list).getAllByRole("button")[0]!);
  } else if (name === "Occurrences") {
    const list = screen.queryByTestId("occurrence-list");
    if (list) fireEvent.click(within(list).getAllByRole("button")[0]!);
  }
}

async function openOccurrence(seq: number) {
  fireEvent.click(screen.getByRole("tab", { name: /^Occurrences/ }));
  fireEvent.click(await screen.findByTestId(`select-occurrence-${seq}`));
}

function subscribeButton() {
  return screen.getByRole("button", {
    name: "Subscribe",
  });
}

/** Open a collapsed accordion section by its heading. */
function openSection(name: RegExp | string) {
  fireEvent.click(screen.getByRole("button", { name }));
}

describe("EventsTab (local)", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.clearAllMocks();
    FakeEventSource.instances = [];
    Object.assign(globalThis, { EventSource: FakeEventSource });
    useTrafficLogStore.getState().clear();
    mockListLocal.mockResolvedValue([]);
  });

  it("opens the project's Servers page from the empty Events landing", () => {
    render(
      <MemoryRouter
        initialEntries={["/p/j18a08twz7b9e36c4z2em8rnns8k2yj3/events"]}
      >
        <Routes>
          <Route path="/p/:projectId/events" element={<EventsTab />} />
          <Route path="/p/:projectId/servers" element={<h1>Servers</h1>} />
        </Routes>
      </MemoryRouter>,
    );

    expect(
      screen.getByText("Choose an MCP server to get started."),
    ).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Open Servers" }));
    expect(screen.getByRole("heading", { name: "Servers" })).toBeVisible();
    expect(mockLoadEventsCatalog).not.toHaveBeenCalled();
  });

  it("explains an undeclared server instead of listing events", async () => {
    mockLoadEventsCatalog.mockResolvedValue(
      catalog([], {
        support: {
          handshakeObserved: true,
          declared: false,
          listChanged: false,
          source: "initialize",
        },
      }),
    );
    renderTab();

    expect(
      await screen.findByRole("heading", { name: "Inspect your server’s events" }),
    ).toBeInTheDocument();
    expect(screen.getByText(/doesn’t advertise Events\./)).toBeVisible();
    const details = screen.getByText("Capability details");
    expect(details.closest("details")).not.toHaveAttribute("open");
    fireEvent.click(details);
    expect(details.closest("details")).toHaveAttribute("open");
    expect(
      screen.getByText("MCP Events capability missing"),
    ).toBeInTheDocument();
    expect(
      screen.queryByTestId("events-profile-badge"),
    ).not.toBeInTheDocument();
    expect(screen.getByText("Raw capabilities")).toBeInTheDocument();
    // Nothing subscribes to the feed of a server that declares nothing.
    expect(FakeEventSource.instances).toHaveLength(0);
    expect(mockListLocal).not.toHaveBeenCalled();
    expect(mockTrack).toHaveBeenCalledWith("events_tab_viewed", {
      location: "events_tab",
    });
  });

  it("lists event types without selecting one", async () => {
    mockLoadEventsCatalog.mockResolvedValue(
      catalog([
        issueCreated,
        {
          name: "pull_request.opened",
          description: "A pull request was opened",
          delivery: ["webhook"],
        },
      ]),
    );
    renderTab();

    const list = await screen.findByTestId("event-types");
    expect(within(list).getByText("issue.created")).toBeInTheDocument();
    expect(
      within(list).getByText("A new issue was opened"),
    ).toBeInTheDocument();
    expect(within(list).getByText("pull_request.opened")).toBeInTheDocument();
    expect(within(list).queryByText("webhook")).not.toBeInTheDocument();
    expect(
      screen.queryByTestId("events-profile-badge"),
    ).not.toBeInTheDocument();
    // The list stays open: nothing is selected until the user picks.
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByRole("tab", { name: /Events/ })).toHaveTextContent("2");
    expect(
      screen.queryByRole("button", { name: /^Subscribe/ }),
    ).not.toBeInTheDocument();
    expect(mockLoadEventsCatalog).toHaveBeenCalledWith(SERVER);
  });

  it("builds the subscribe form from inputSchema and posts the local body", async () => {
    mockLoadEventsCatalog.mockResolvedValue(catalog([issueCreated]));
    mockCreateLocal.mockResolvedValue(subscriptionView({ mode: "poll" }));
    renderTab();

    await openEventType("issue.created");
    const repo = await screen.findByPlaceholderText("Enter repo");
    fireEvent.change(repo, { target: { value: "octo/hello" } });
    // A server with no sign-in defaults to push, then the user picks poll.
    expect(screen.getByRole("radio", { name: /Push/ })).toBeChecked();
    fireEvent.click(screen.getByRole("radio", { name: /Poll/ }));
    expect(screen.getByRole("radio", { name: /Poll/ })).toBeChecked();
    openSection(/Advanced settings/);
    fireEvent.change(screen.getByLabelText("maxAgeMs"), {
      target: { value: "60000" },
    });
    // ttlMs is a webhook subscription's lifetime: not offered for poll.
    expect(screen.queryByLabelText("ttlMs")).toBeNull();
    // A double click still creates one subscription.
    const subscribe = subscribeButton();
    fireEvent.click(subscribe);
    fireEvent.click(subscribe);

    await waitFor(() => expect(mockCreateLocal).toHaveBeenCalledTimes(1));
    expect(mockCreateLocal).toHaveBeenCalledWith({
      serverId: SERVER,
      eventName: "issue.created",
      arguments: { repo: "octo/hello" },
      mode: "poll",
      // No client is active: MCPJam (built-in), named explicitly.
      host: null,
      maxAgeMs: 60000,
    });
    expect(mockCreateLocal).toHaveBeenCalledTimes(1);
    // A successful subscribe returns to the selected event workspace.
    await screen.findByRole("tabpanel", { name: "Subscriptions" });
    await openWorkspaceView("Subscriptions");
    expect(
      await screen.findByTestId("subscription-esub_1"),
    ).toBeInTheDocument();
  });

  it("falls back to raw JSON arguments when the schema has no fields", async () => {
    mockLoadEventsCatalog.mockResolvedValue(
      catalog([{ name: "tick", delivery: ["poll"] }]),
    );
    mockCreateLocal.mockResolvedValue(subscriptionView({ eventName: "tick" }));
    renderTab();

    await openEventType("tick");
    const raw = await screen.findByLabelText("Arguments JSON");
    fireEvent.change(raw, { target: { value: '{"every":"1m"}' } });
    fireEvent.click(subscribeButton());
    await waitFor(() =>
      expect(mockCreateLocal).toHaveBeenCalledWith(
        expect.objectContaining({ arguments: { every: "1m" }, mode: "poll" }),
      ),
    );
  });

  it("subscribes as the active client, offering only the modes it receives", async () => {
    mockLoadEventsCatalog.mockResolvedValue(catalog([issueCreated]));
    mockCreateLocal.mockResolvedValue(
      subscriptionView({ host: { id: "host_chatgpt", name: "ChatGPT" } }),
    );
    render(
      <EventsTab
        serverConfig={serverConfig()}
        serverName={SERVER}
        activeHostId="host_chatgpt"
        activeHost={{
          // Saved, as the template saves it: the Apps style decides nothing.
          mcpProfile: {
            profileVersion: 1,
            extensions: { "com.mcpjam/events": { webhook: true } },
          },
        }}
      />,
    );

    await screen.findByTestId("event-types");
    await openEventType("issue.created");
    // Modes the client refuses stay listed, disabled, with the reason.
    expect(screen.getByRole("radio", { name: /Poll/ })).toBeDisabled();
    expect(screen.getByRole("radio", { name: /Push/ })).toBeDisabled();
    const delivery = screen.getByTestId("subscribe-delivery");
    expect(
      within(delivery).getByText(
        "ChatGPT doesn't receive events by poll. Turn it on in the client's Events tab, or pick another client.",
      ),
    ).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: /Webhook/ })).toBeChecked();

    fireEvent.change(screen.getByPlaceholderText("Enter repo"), {
      target: { value: "octo/hello" },
    });
    fireEvent.click(
      screen.getByRole("checkbox", {
        name: /Allow plain HTTP for local development/,
      }),
    );
    fireEvent.click(subscribeButton());
    await waitFor(() =>
      expect(mockCreateLocal).toHaveBeenCalledWith(
        expect.objectContaining({
          mode: "webhook",
          host: {
            id: "host_chatgpt",
            name: "ChatGPT",
            eventDeliveryModes: ["webhook"],
          },
        }),
      ),
    );
    await screen.findByRole("tabpanel", { name: "Subscriptions" });
    await openWorkspaceView("Subscriptions");
    const card = await screen.findByTestId("subscription-esub_1");
    expect(within(card).getByTestId("subscription-host")).toHaveTextContent(
      "ChatGPT",
    );
  });

  it("shows every event for a client without Events support but disables Subscribe with the reason", async () => {
    mockLoadEventsCatalog.mockResolvedValue(catalog([issueCreated]));
    render(
      <EventsTab
        serverConfig={serverConfig()}
        serverName={SERVER}
        activeHostId="host_claude"
        activeHost={{
          hostStyle: "chatgpt",
          mcpProfile: { extensions: { "com.mcpjam/events": {} } },
        }}
      />,
    );

    const list = await screen.findByTestId("event-types");
    expect(within(list).getByText("issue.created")).toBeInTheDocument();
    await openEventType("issue.created");
    const blocked = await screen.findByTestId("subscribe-blocked");
    expect(blocked).toHaveTextContent(
      "doesn't receive events. Turn on a delivery mode in the client's Events tab, or pick another client.",
    );
    // Client policy is fixed in Clients, not with a picker here.
    expect(
      within(blocked).getByRole("button", { name: "Open Clients" }),
    ).toBeInTheDocument();
    expect(screen.queryByLabelText("Events client")).toBeNull();
    expect(subscribeButton()).toBeDisabled();
  });

  it("requires the development-receiver acknowledgement for a local webhook", async () => {
    mockLoadEventsCatalog.mockResolvedValue(
      catalog([{ ...issueCreated, delivery: ["webhook"] }]),
    );
    mockCreateLocal.mockResolvedValue(
      subscriptionView({ overrides: ["insecure-local-receiver"] }),
    );
    renderTab();

    await openEventType("issue.created");
    fireEvent.change(await screen.findByPlaceholderText("Enter repo"), {
      target: { value: "octo/hello" },
    });
    const subscribe = subscribeButton();
    expect(subscribe).toBeDisabled();

    fireEvent.click(
      screen.getByRole("checkbox", {
        name: /Allow plain HTTP for local development/,
      }),
    );
    expect(subscribe).toBeEnabled();
    fireEvent.click(subscribe);

    await waitFor(() =>
      expect(mockCreateLocal).toHaveBeenCalledWith(
        expect.objectContaining({
          mode: "webhook",
          receiver: { kind: "local" },
          ttlMs: 600_000,
          overrides: ["insecure-local-receiver"],
        }),
      ),
    );
    await screen.findByRole("tabpanel", { name: "Subscriptions" });
    await openWorkspaceView("Subscriptions");
    const card = await screen.findByTestId("subscription-esub_1");
    expect(within(card).getByText("Plain HTTP")).toBeInTheDocument();
  });

  it("validates Custom URL and sends the explicit no-expiry choice", async () => {
    mockLoadEventsCatalog.mockResolvedValue(
      catalog([{ ...issueCreated, delivery: ["webhook"] }], {
        localCallbackBase: "http://127.0.0.1:6274/api/mcp/events/hooks",
      }),
    );
    mockCreateLocal.mockResolvedValue(subscriptionView());
    renderTab();

    await openEventType("issue.created");
    fireEvent.click(await screen.findByRole("radio", { name: "Custom URL" }));
    const input = screen.getByLabelText("Callback URL");
    expect(subscribeButton()).toBeDisabled();
    fireEvent.change(input, { target: { value: "https://proxy.example/hooks?" } });
    expect(screen.getByText("Remove the query string or fragment from the callback URL.")).toBeVisible();
    expect(subscribeButton()).toBeDisabled();

    fireEvent.change(input, { target: { value: "http://proxy.example/hooks" } });
    expect(subscribeButton()).toBeDisabled();
    expect(screen.getByRole("checkbox", { name: /Allow plain HTTP/ })).toBeVisible();

    fireEvent.change(input, { target: { value: "https://proxy.example/hooks" } });
    expect(screen.queryByRole("checkbox", { name: /Allow plain HTTP/ })).toBeNull();
    expect(screen.getByText("https://proxy.example/hooks/* → http://127.0.0.1:6274/api/mcp/events/hooks/*")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Advanced settings" }));
    expect(screen.getByPlaceholderText("10 minutes")).toBeVisible();
    fireEvent.click(screen.getByRole("checkbox", { name: "No expiry" }));
    expect(screen.getByText("The server can keep sending events after MCPJam closes.")).toBeVisible();
    fireEvent.change(screen.getByPlaceholderText("Enter repo"), { target: { value: "octo/hello" } });
    fireEvent.click(subscribeButton());
    await waitFor(() => expect(mockCreateLocal).toHaveBeenCalledWith(expect.objectContaining({
      receiver: { kind: "custom", baseUrl: "https://proxy.example/hooks" },
      ttlMs: null,
    })));
    expect(mockCreateLocal.mock.calls[0]?.[0]).not.toHaveProperty("overrides");
  });

  it("moves from waiting to verified to receiving on local subscription frames", async () => {
    mockLoadEventsCatalog.mockResolvedValue(catalog([issueCreated]));
    mockListLocal.mockResolvedValue([subscriptionView()]);
    renderTab();

    await screen.findByTestId("events-activity");
    await openWorkspaceView("Subscriptions");
    const headline = await screen.findByTestId("webhook-reachability");
    expect(headline).toHaveTextContent("Waiting for the first delivery");
    emitFrame({ type: "subscription", subscription: subscriptionView({ callbackVerifiedAt: Date.now() }) });
    expect(headline).toHaveTextContent("Server reached MCPJam");
    emitFrame({ type: "subscription", subscription: subscriptionView({ lastWebhookAt: Date.now() }) });
    expect(headline).toHaveTextContent("Receiving webhook events");
  });

  it("renders stream frames: snapshot, simulated entry with flags, rejection", async () => {
    mockLoadEventsCatalog.mockResolvedValue(catalog([issueCreated]));
    renderTab();

    await screen.findByTestId("event-types");
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));
    expect(FakeEventSource.instances[0]!.url).toBe(
      "/api/mcp/events/stream?after=0",
    );

    emitFrame({
      type: "snapshot",
      nextAfter: 0,
      subscriptions: [
        subscriptionView({
          conflictingServerSubscriptionId: "srv-sub-other",
          lastError: {
            kind: "callback_http_5xx",
            message: "Callback returned 500",
            at: Date.now(),
            retryable: true,
          },
        }),
      ],
    });
    await openWorkspaceView("Subscriptions");
    const card = await screen.findByTestId("subscription-esub_1");
    expect(within(card).getByText("srv-sub-other")).toBeInTheDocument();
    expect(within(card).getByText(/The receiver returned an error/)).toBeInTheDocument();
    expect(within(card).getByTestId("observed-state")).toHaveTextContent(
      "Active",
    );
    await openWorkspaceView("Occurrences");

    emitFrame({
      type: "entry",
      entry: {
        seq: 1,
        kind: "event",
        origin: "simulation",
        namespace: "simulation",
        logicalSubscriptionId: "esub_1",
        eventId: "evt_1",
        name: "issue.created",
        timestamp: "2026-09-30T00:00:00Z",
        cursor: "c-1",
        receivedAt: Date.now(),
        dispatch: "pending",
        idConflict: true,
        data: { title: "hello" },
      },
    });
    await openOccurrence(1);
    const entry = await screen.findByTestId("feed-entry");
    expect(within(entry).getByTestId("namespace-badge")).toHaveTextContent(
      "Test",
    );
    expect(
      within(entry).getByText("Subscription mismatch"),
    ).toBeInTheDocument();
    expect(within(entry).getByText("evt_1")).toBeInTheDocument();
    expect(within(entry).getByText("pending")).toBeInTheDocument();

    // A replayed frame (the browser reconnects with the same `after`) is
    // deduplicated by seq.
    emitFrame({
      type: "entry",
      entry: {
        seq: 1,
        kind: "event",
        origin: "simulation",
        namespace: "simulation",
        logicalSubscriptionId: "esub_1",
        receivedAt: Date.now(),
      },
    });
    expect(screen.getAllByTestId("feed-entry")).toHaveLength(1);

    // Tracing gets one RECEIVE row per entry, named by its delivery mode and event type.
    const rows = useTrafficLogStore
      .getState()
      .mcpServerItems.filter((item) => item.kind === "webhook");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      direction: "RECEIVE",
      method: "simulation event · issue.created",
      serverId: SERVER,
    });

    emitFrame({
      type: "rejection",
      rejection: {
        reason: "bad_signature",
        slotId: "slot_1",
        at: Date.now(),
        headerNames: ["webhook-id", "webhook-signature"],
        bodyBytes: 120,
      },
    });
    openSection(/Rejected deliveries/);
    const rejections = await screen.findByTestId("rejections");
    expect(within(rejections).getByText("bad_signature")).toBeInTheDocument();
    expect(
      within(rejections).getByText("headers: webhook-id, webhook-signature"),
    ).toBeInTheDocument();
  });

  it("reads and subscribes in the current project, and starts over in another", async () => {
    mockLoadEventsCatalog.mockResolvedValue(catalog([issueCreated]));
    mockCreateLocal.mockResolvedValue(subscriptionView({ mode: "poll" }));
    const tab = (projectId: string | null) => (
      <EventsTab
        serverConfig={serverConfig()}
        serverName={SERVER}
        projectId={projectId}
        localProjectId="local_project"
      />
    );
    const { rerender } = render(tab(null));

    // Without a Convex project, the local project scopes the registry and feed.
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));
    expect(FakeEventSource.instances[0]!.url).toBe(
      "/api/mcp/events/stream?after=0&projectId=local_project",
    );
    await waitFor(() =>
      expect(mockListLocal).toHaveBeenCalledWith(SERVER, "local_project"),
    );
    await openEventType("issue.created");
    fireEvent.change(await screen.findByPlaceholderText("Enter repo"), {
      target: { value: "octo/hello" },
    });
    fireEvent.click(subscribeButton());
    await waitFor(() =>
      expect(mockCreateLocal).toHaveBeenCalledWith(
        expect.objectContaining({ projectId: "local_project", serverId: SERVER }),
      ),
    );
    emitFrame({
      type: "entry",
      entry: {
        seq: 1,
        kind: "event",
        origin: "push",
        namespace: "live",
        logicalSubscriptionId: "esub_1",
        receivedAt: Date.now(),
      },
    });
    expect(screen.getByRole("tab", { name: /^Occurrences/ })).toHaveTextContent("1");

    // A Convex project wins, and nothing from the previous project carries over.
    rerender(tab("convex_project"));
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(2));
    expect(FakeEventSource.instances[0]!.closed).toBe(true);
    expect(FakeEventSource.instances[1]!.url).toBe(
      "/api/mcp/events/stream?after=0&projectId=convex_project",
    );
    await waitFor(() =>
      expect(mockListLocal).toHaveBeenCalledWith(SERVER, "convex_project"),
    );
    expect(screen.getByRole("tab", { name: /^Occurrences/ })).toHaveTextContent("0");
    expect(screen.getByRole("tab", { name: /^Subscriptions/ })).toHaveTextContent("0");
  });

  it("renders event data as text, never as HTML", async () => {
    mockLoadEventsCatalog.mockResolvedValue(catalog([issueCreated]));
    const { container } = renderTab();
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));

    const payload = '<img src=x onerror="window.__eventsPwned=1">';
    emitFrame({
      type: "entry",
      entry: {
        seq: 7,
        kind: "event",
        origin: "webhook",
        namespace: "live",
        logicalSubscriptionId: "esub_x",
        name: "issue.created",
        receivedAt: Date.now(),
        data: { title: payload, body: "**bold** [link](javascript:alert(1))" },
      },
    });

    await openOccurrence(7);
    const row = await screen.findByTestId("feed-entry");
    const data = within(row).getAllByTestId("event-data")[0]!;
    expect(data.textContent).toContain(JSON.stringify(payload));
    expect(data.textContent).toContain("**bold**");
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("a[href^='javascript']")).toBeNull();
    expect(
      (window as unknown as { __eventsPwned?: number }).__eventsPwned,
    ).toBeUndefined();
  });

  it("keeps manual event triggering out of server inspection", async () => {
    mockLoadEventsCatalog.mockResolvedValue(catalog([issueCreated]));
    mockListLocal.mockResolvedValue([subscriptionView()]);
    renderTab();

    await screen.findByRole("tab", { name: /Subscriptions\s*1/ });
    expect(
      screen.queryByRole("button", { name: "Trigger event" }),
    ).not.toBeInTheDocument();

    const list = await screen.findByTestId("event-types");
    fireEvent.click(
      within(list).getByRole("button", { name: /issue.created/ }),
    );
    expect(screen.getByRole("button", { name: "Subscribe" })).toBeEnabled();
    expect(
      screen.queryByRole("button", { name: "Trigger event" }),
    ).not.toBeInTheDocument();
  });

  it("pauses a subscription through the local route", async () => {
    mockLoadEventsCatalog.mockResolvedValue(catalog([issueCreated]));
    mockListLocal.mockResolvedValue([subscriptionView()]);
    // A desired-state change bumps the generation, as the runtime does.
    mockSetLocalState.mockResolvedValue(
      subscriptionView({
        generation: 3,
        desiredState: "paused",
        observedState: "paused",
      }),
    );
    renderTab();

    await screen.findByTestId("events-activity");
    await openWorkspaceView("Subscriptions");
    const card = await screen.findByTestId("subscription-esub_1");
    fireEvent.click(within(card).getByRole("button", { name: /Pause/ }));
    await waitFor(() =>
      expect(mockSetLocalState).toHaveBeenCalledWith("esub_1", "paused"),
    );
    expect(
      await within(card).findByRole("button", { name: /Resume/ }),
    ).toBeInTheDocument();
  });

  it("keeps catalog search and selection while inspecting event type details or closing setup", async () => {
    mockLoadEventsCatalog.mockResolvedValue(
      catalog([
        issueCreated,
        { name: "pull_request.opened", delivery: ["webhook"] },
      ]),
    );
    renderTab();

    const search = await screen.findByPlaceholderText("Search event types...");
    fireEvent.change(search, { target: { value: "issue" } });
    expect(
      within(screen.getByTestId("event-types")).queryByText(
        "pull_request.opened",
      ),
    ).toBeNull();

    const list = screen.getByTestId("event-types");
    const row = within(list).getByRole("button", {
      name: /issue\.created/,
    });
    fireEvent.click(row);
    expect(row).toHaveAttribute("aria-pressed", "true");
    expect(search).toHaveValue("issue");
    expect(screen.queryByRole("dialog")).toBeNull();

    await openWorkspaceView("Event type details");
    expect(screen.getByText("Raw JSON")).toBeInTheDocument();
    await openWorkspaceView("Subscribe");
    expect(
      screen.getByRole("tabpanel", { name: "Subscribe" }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.change(screen.getByPlaceholderText("Enter repo"), {
      target: { value: "octo/hello" },
    });
    await openWorkspaceView("Occurrences");
    await openWorkspaceView("Subscribe");
    expect(screen.getByPlaceholderText("Enter repo")).toHaveValue("octo/hello");
    const restoredSearch = screen.getByPlaceholderText("Search event types...");
    expect(restoredSearch).toHaveValue("issue");
    fireEvent.change(restoredSearch, { target: { value: "" } });
    fireEvent.click(
      within(screen.getByTestId("event-types")).getByRole("button", {
        name: /pull_request\.opened/,
      }),
    );
    expect(
      within(screen.getByTestId("event-types")).getByRole("button", {
        name: /issue\.created/,
      }),
    ).toHaveAttribute("aria-pressed", "false");
    expect(
      screen.getByRole("heading", { name: "pull_request.opened" }),
    ).toBeInTheDocument();
  });

  it("browses all server subscriptions, including event types no longer listed", async () => {
    mockLoadEventsCatalog.mockResolvedValue(catalog([issueCreated]));
    mockListLocal.mockResolvedValue([
      subscriptionView(),
      subscriptionView({
        id: "esub_2",
        eventName: "issue.closed",
        mode: "poll",
        desiredState: "paused",
        observedState: "paused",
      }),
    ]);
    renderTab();
    await openEventType("issue.created");
    await openWorkspaceView("Subscriptions");
    expect(
      screen.getByRole("tab", { name: /^Subscriptions/ }),
    ).toHaveTextContent("2");
    expect(
      screen.getByTestId("select-subscription-esub_2"),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("select-subscription-esub_2"));
    const orphan = await screen.findByTestId("subscription-esub_2");
    expect(
      within(orphan).getByRole("button", { name: /Stop polling/ }),
    ).toBeInTheDocument();
    expect(screen.queryByTestId("subscription-esub_1")).not.toBeInTheDocument();
    expect(screen.queryByText("All events")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("tablist", { name: "Event workspace" }),
    ).not.toBeInTheDocument();
  });

  it("keeps the three browse tabs on mobile and opens details only after selection", async () => {
    mockLoadEventsCatalog.mockResolvedValue(catalog([issueCreated]));
    renderTab();
    await screen.findByRole("tab", { name: /^Events/ });
    expect(screen.getAllByRole("tab").map((tab) => tab.textContent)).toEqual([
      "Events1",
      "Subscriptions0",
      "Occurrences0",
    ]);
    expect(screen.getByTestId("mobile-selection")).toBeEmptyDOMElement();
    fireEvent.click(screen.getByRole("tab", { name: /^Occurrences/ }));
    expect(screen.getByTestId("mobile-selection")).toBeEmptyDOMElement();
    expect(
      screen.queryByRole("button", { name: /Rejected deliveries/ }),
    ).not.toBeInTheDocument();
    await openEventType("issue.created");
    expect(screen.getByTestId("mobile-selection")).toHaveTextContent(
      "issue.created",
    );
    fireEvent.click(screen.getByRole("button", { name: "Back to catalog" }));
    expect(screen.getByTestId("mobile-selection")).toBeEmptyDOMElement();
  });

  it("shows connection failures in the workspace", async () => {
    mockLoadEventsCatalog.mockResolvedValue(catalog([issueCreated]));
    renderTab();
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));
    act(() => FakeEventSource.instances[0]!.onerror?.());
    expect(await screen.findByTestId("feed-status")).toHaveTextContent(
      "Reconnecting",
    );
    expect(screen.queryByTestId("events-host-label")).not.toBeInTheDocument();
  });

  it("names why the server terminated a subscription, for draft and Beta codes", async () => {
    mockLoadEventsCatalog.mockResolvedValue(catalog([issueCreated]));
    renderTab();
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));

    const terminated = (message: string) => ({
      kind: "terminated",
      message,
      at: Date.now(),
      retryable: false,
    });
    emitFrame({
      type: "snapshot",
      nextAfter: 0,
      subscriptions: [
        subscriptionView({
          observedState: "terminated",
          lastError: terminated("Forbidden"),
        }),
        subscriptionView({
          id: "esub_2",
          mode: "push",
          observedState: "terminated",
          lastError: terminated("Unsupported"),
        }),
        subscriptionView({
          id: "esub_3",
          mode: "poll",
          observedState: "terminated",
          lastError: terminated("NotFound"),
        }),
      ],
    });
    const entry = (
      seq: number,
      logicalSubscriptionId: string,
      error: { code: number; message: string; data?: unknown },
    ) =>
      emitFrame({
        type: "entry",
        entry: {
          seq,
          kind: "terminated",
          origin: "webhook",
          namespace: "live",
          logicalSubscriptionId,
          receivedAt: Date.now(),
          error,
        },
      });
    entry(1, "esub_1", {
      code: -32024,
      message: "Forbidden",
      data: { reason: "Access revoked" },
    });
    entry(2, "esub_2", {
      code: -32026,
      message: "Unsupported",
      data: { feature: "payloadSchema", reason: "schema_changed" },
    });
    entry(3, "esub_3", {
      code: -32011,
      message: "NotFound",
      data: { kind: "event" },
    });

    await openWorkspaceView("Subscriptions");
    const reasons = [
      ["esub_1", "Access revoked"],
      [
        "esub_2",
        "Schema changed. Refresh the event types, then subscribe again.",
      ],
      ["esub_3", "Event type removed"],
    ];
    for (const [id, reason] of reasons) {
      fireEvent.click(screen.getByTestId(`select-subscription-${id}`));
      expect(
        within(screen.getByTestId(`subscription-${id}`)).getByTestId(
          "subscription-termination",
        ),
      ).toHaveTextContent(reason!);
    }
    await openOccurrence(1);
    expect(
      screen.getAllByTestId("termination-reason").map((row) => row.textContent),
    ).toEqual(
      expect.arrayContaining([expect.stringContaining("Access revoked")]),
    );
  });

  it("shows webhook delivery status, and an event type the server can't replay", async () => {
    mockLoadEventsCatalog.mockResolvedValue(catalog([issueCreated]));
    mockListLocal.mockResolvedValue([
      subscriptionView({
        lastCursor: null,
        deliveryStatus: {
          active: false,
          lastDeliveryAt: "2026-02-19T15:45:00Z",
          lastError: "http_4xx",
          failedSince: "2026-02-19T15:50:00Z",
        },
      }),
      subscriptionView({
        id: "esub_2",
        deliveryStatus: {
          active: true,
          lastError: null,
          throttled: true,
          retryAfterMs: 60000,
        },
      }),
    ]);
    renderTab();

    await screen.findByTestId("events-activity");
    await openWorkspaceView("Subscriptions");
    const suspended = await screen.findByTestId("subscription-esub_1");
    expect(within(suspended).getByText(/The receiver refused a delivery/)).toHaveTextContent(
      "The server suspended delivery.",
    );
    expect(within(suspended).queryByText("Delivering")).toBeNull();
    expect(
      within(suspended).getByText("null (replay not supported)"),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("select-subscription-esub_2"));
    expect(
      within(screen.getByTestId("subscription-esub_2")).getByText(/The server slowed webhook delivery/),
    ).toBeInTheDocument();

    await openEventType("issue.created");
    expect(screen.getByTestId("replay-unsupported")).toBeInTheDocument();
  });

  it("reads the catalog again when the server says its event types changed, keeping the draft", async () => {
    mockLoadEventsCatalog.mockResolvedValue(catalog([issueCreated]));
    renderTab();

    await openEventType("issue.created");
    fireEvent.change(await screen.findByPlaceholderText("Enter repo"), {
      target: { value: "octo/hello" },
    });
    expect(mockLoadEventsCatalog).toHaveBeenCalledTimes(1);

    act(() => {
      useTrafficLogStore.getState().addMcpServerLog({
        serverId: SERVER,
        direction: "RECEIVE",
        method: "notifications/events/list_changed",
        timestamp: new Date().toISOString(),
        payload: {
          jsonrpc: "2.0",
          method: "notifications/events/list_changed",
        },
      });
    });

    await waitFor(() => expect(mockLoadEventsCatalog).toHaveBeenCalledTimes(2));
    expect(
      await screen.findByRole("tabpanel", { name: "Subscribe" }),
    ).toBeInTheDocument();
    expect(screen.getByPlaceholderText("Enter repo")).toHaveValue("octo/hello");
  });

  it("refreshes a Beta catalog from the watch and ends the watch on unmount", async () => {
    const support = { ...declaredSupport, beta: true, listChanged: true };
    mockLoadEventsCatalog.mockResolvedValue(
      catalog([issueCreated], { support }),
    );
    mockWatchEventsCatalog.mockResolvedValue(undefined);
    const view = renderTab();

    await waitFor(() =>
      expect(mockWatchEventsCatalog).toHaveBeenCalledTimes(1),
    );
    expect(
      screen.queryByTestId("events-profile-badge"),
    ).not.toBeInTheDocument();
    const [serverName, signal, onChange] =
      mockWatchEventsCatalog.mock.calls[0]!;
    expect(serverName).toBe(SERVER);
    mockLoadEventsCatalog.mockResolvedValue(
      catalog([{ ...issueCreated, name: "issue.closed" }], { support }),
    );
    act(onChange);
    expect(await screen.findByText("issue.closed")).toBeInTheDocument();
    expect(mockWatchEventsCatalog).toHaveBeenCalledTimes(1);

    view.unmount();
    expect(signal.aborted).toBe(true);
  });

  it("keeps the newer streamed state when an action's response arrives late", async () => {
    mockLoadEventsCatalog.mockResolvedValue(catalog([issueCreated]));
    mockListLocal.mockResolvedValue([subscriptionView({ generation: 2 })]);
    let respond: (view: EventsSubscriptionView) => void = () => undefined;
    mockSetLocalState.mockImplementation(
      () =>
        new Promise<EventsSubscriptionView>((resolve) => {
          respond = resolve;
        }),
    );
    renderTab();

    await screen.findByTestId("events-activity");
    await openWorkspaceView("Subscriptions");
    const card = await screen.findByTestId("subscription-esub_1");
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));
    fireEvent.click(within(card).getByRole("button", { name: /Pause/ }));
    await waitFor(() => expect(mockSetLocalState).toHaveBeenCalled());

    // The stream reports the pause before the request returns...
    emitFrame({
      type: "subscription",
      subscription: subscriptionView({
        generation: 3,
        desiredState: "paused",
        observedState: "paused",
      }),
    });
    expect(within(card).getByTestId("observed-state")).toHaveTextContent(
      "Paused",
    );
    // ...and the response, as of when the request was handled, is older.
    await act(async () => {
      respond(
        subscriptionView({
          generation: 3,
          desiredState: "paused",
          observedState: "active",
        }),
      );
    });
    expect(within(card).getByTestId("observed-state")).toHaveTextContent(
      "Paused",
    );
  });
});
