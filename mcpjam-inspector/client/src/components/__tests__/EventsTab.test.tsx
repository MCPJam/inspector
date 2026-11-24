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
import type {
  EventsListResponse,
  EventsSubscriptionView,
} from "@/shared/events-api";

const mockLoadEventsCatalog = vi.fn();
const mockWatchEventsCatalog = vi.fn<(serverName: string, signal: AbortSignal, onChange: () => void) => Promise<void>>();
const mockListLocal = vi.fn();
const mockCreateLocal = vi.fn();
const mockSetLocalState = vi.fn();
const mockSimulate = vi.fn();
const mockTrack = vi.fn();

vi.mock("@/lib/apis/mcp-events-api", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  loadEventsCatalog: (...args: unknown[]) => mockLoadEventsCatalog(...args),
  watchEventsCatalog: (...args: Parameters<typeof mockWatchEventsCatalog>) => mockWatchEventsCatalog(...args),
  listLocalEventSubscriptions: (...args: unknown[]) => mockListLocal(...args),
  createLocalEventSubscription: (...args: unknown[]) =>
    mockCreateLocal(...args),
  setLocalEventSubscriptionState: (...args: unknown[]) =>
    mockSetLocalState(...args),
  rotateLocalEventSubscriptionSecret: vi.fn(),
  simulateEvent: (...args: unknown[]) => mockSimulate(...args),
  fetchLocalEventsFeed: vi
    .fn()
    .mockResolvedValue({ entries: [], nextAfter: 0 }),
  localEventsStreamUrl: (after: number) =>
    `/api/mcp/events/stream?after=${after}`,
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
      <span data-testid="mobile-selection">{mobileNavigation.selectionKey}</span>
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

/** Select an event type and open its subscribe sheet. */
async function openEventType(name: string) {
  const list = await screen.findByTestId("event-types");
  fireEvent.click(within(list).getByRole("button", { name: new RegExp(name) }));
  fireEvent.click(screen.getByRole("button", { name: "Subscribe" }));
  return screen.findByRole("dialog");
}

function openWorkspaceView(name: "Received" | "Subscriptions" | "Definition") {
  const tabs = screen.getByRole("tablist", { name: "Event workspace" });
  fireEvent.click(within(tabs).getByRole("tab", { name: new RegExp(`^${name}`) }));
}

function subscribeButton() {
  return within(screen.getByRole("dialog")).getByRole("button", {
    name: "Subscribe",
  });
}

/** Open a collapsed accordion section by its heading. */
function openSection(name: RegExp | string) {
  fireEvent.click(screen.getByRole("button", { name }));
}

describe("EventsTab (local)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    FakeEventSource.instances = [];
    Object.assign(globalThis, { EventSource: FakeEventSource });
    useTrafficLogStore.getState().clear();
    mockListLocal.mockResolvedValue([]);
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
      await screen.findByText("This server does not declare events"),
    ).toBeInTheDocument();
    expect(
      screen.getByText("MCP Events capability missing"),
    ).toBeInTheDocument();
    expect(screen.queryByTestId("events-profile-badge")).not.toBeInTheDocument();
    expect(screen.getByText("Raw capabilities")).toBeInTheDocument();
    // Nothing subscribes to the feed of a server that declares nothing.
    expect(FakeEventSource.instances).toHaveLength(0);
    expect(mockListLocal).not.toHaveBeenCalled();
    expect(mockTrack).toHaveBeenCalledWith("events_tab_viewed", {
      location: "events_tab",
    });
  });

  it("lists event types and keeps server details behind a disclosure", async () => {
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
    expect(screen.queryByTestId("events-profile-badge")).not.toBeInTheDocument();
    // The list stays open: nothing is selected until the user picks.
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByRole("tab", { name: /Events/ })).toHaveTextContent("2");
    expect(screen.getByRole("button", { name: /^Subscribe/ })).toBeDisabled();
    // The declared capability is one disclosure away.
    openSection(/Server details/);
    expect(
      screen.getByText("capabilities.events declared"),
    ).toBeInTheDocument();
    expect(mockLoadEventsCatalog).toHaveBeenCalledWith(SERVER);
  });

  it("builds the subscribe form from inputSchema and posts the local body", async () => {
    mockLoadEventsCatalog.mockResolvedValue(catalog([issueCreated]));
    mockCreateLocal.mockResolvedValue(subscriptionView({ mode: "poll" }));
    renderTab();

    await openEventType("issue.created");
    const repo = await screen.findByPlaceholderText("Enter repo");
    fireEvent.change(repo, { target: { value: "octo/hello" } });
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
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    openWorkspaceView("Subscriptions");
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
        activeHost={{ hostStyle: "chatgpt" }}
      />,
    );

    await screen.findByTestId("event-types");
    expect(screen.queryByTestId("events-host-label")).not.toBeInTheDocument();
    openSection(/Server details/);
    expect(await screen.findByTestId("events-host-label")).toHaveTextContent(
      "ChatGPT",
    );
    await openEventType("issue.created");
    // Modes the client refuses stay listed, disabled, with the reason.
    expect(screen.getByRole("radio", { name: /Poll/ })).toBeDisabled();
    expect(screen.getByRole("radio", { name: /Push/ })).toBeDisabled();
    const delivery = screen.getByTestId("subscribe-delivery");
    expect(
      within(delivery).getByText(
        "ChatGPT doesn't receive events by poll. Turn it on in its Protocol settings, or pick another client.",
      ),
    ).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: /Webhook/ })).toBeChecked();

    fireEvent.change(screen.getByPlaceholderText("Enter repo"), {
      target: { value: "octo/hello" },
    });
    fireEvent.click(
      screen.getByRole("checkbox", {
        name: /Use local development receiver/,
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
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    openWorkspaceView("Subscriptions");
    const card = await screen.findByTestId("subscription-esub_1");
    fireEvent.click(within(card).getByRole("button"));
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
      "doesn't receive events. Turn on a delivery mode in its Protocol settings, or pick another client.",
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
        name: /Use local development receiver \(non-conformant, plain http\)/,
      }),
    );
    expect(subscribe).toBeEnabled();
    fireEvent.click(subscribe);

    await waitFor(() =>
      expect(mockCreateLocal).toHaveBeenCalledWith(
        expect.objectContaining({
          mode: "webhook",
          overrides: ["insecure-local-receiver"],
        }),
      ),
    );
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    openWorkspaceView("Subscriptions");
    const card = await screen.findByTestId("subscription-esub_1");
    expect(within(card).getByText("Development override")).toBeInTheDocument();
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
            kind: "delivery_failed",
            message: "Callback returned 500",
            at: Date.now(),
            retryable: true,
          },
        }),
      ],
    });
    openWorkspaceView("Subscriptions");
    const card = await screen.findByTestId("subscription-esub_1");
    expect(within(card).getByText("srv-sub-other")).toBeInTheDocument();
    expect(within(card).getByText(/Callback returned 500/)).toBeInTheDocument();
    expect(within(card).getByTestId("observed-state")).toHaveTextContent(
      "Active",
    );
    openWorkspaceView("Received");

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
    const entry = await screen.findByTestId("feed-entry");
    fireEvent.click(within(entry).getByRole("button"));
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

    // Tracing gets a redacted webhook RECEIVE row per entry.
    const rows = useTrafficLogStore
      .getState()
      .mcpServerItems.filter((item) => item.kind === "webhook");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      direction: "RECEIVE",
      method: "webhook event",
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

    const row = await screen.findByTestId("feed-entry");
    expect(within(row).queryByTestId("event-data")).not.toBeInTheDocument();
    fireEvent.click(within(row).getByRole("button"));
    const data = within(row).getAllByTestId("event-data")[0]!;
    expect(data.textContent).toContain(JSON.stringify(payload));
    expect(data.textContent).toContain("**bold**");
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("a[href^='javascript']")).toBeNull();
    expect(
      (window as unknown as { __eventsPwned?: number }).__eventsPwned,
    ).toBeUndefined();
  });

  it("triggers a test event and shows the journalled entry", async () => {
    mockLoadEventsCatalog.mockResolvedValue(catalog([issueCreated, { name: "pull_request.opened", delivery: ["webhook"] }]));
    mockListLocal.mockResolvedValue([subscriptionView(), subscriptionView({id: "other-sub", eventName: "pull_request.opened"})]);
    mockSimulate.mockRejectedValueOnce(new Error("Receiver unavailable")).mockResolvedValue({
      entry: {
        seq: 11,
        kind: "event",
        origin: "simulation",
        namespace: "simulation",
        logicalSubscriptionId: "esub_1",
        eventId: "sim-1",
        name: "issue.created",
        receivedAt: Date.now(),
        data: { title: "Example" },
      },
    });
    renderTab();

    const list = await screen.findByTestId("event-types");
    fireEvent.click(within(list).getByRole("button", { name: /issue.created/ }));
    openSection(/^Trigger event$/);
    expect(screen.getByTestId("simulate-warning")).toHaveTextContent(
      "Matching triggers can run",
    );
    const panel = await screen.findByTestId("simulate-panel");
    fireEvent.click(within(panel).getByRole("combobox", { name: "Subscription" }));
    expect(screen.getAllByRole("option")).toHaveLength(1);
    fireEvent.click(screen.getByRole("option", { name: "issue.created (webhook)" }));
    // Prefilled from the payload schema's defaults.
    await waitFor(() =>
      expect(
        (
          within(panel).getByLabelText(
            "Event data (JSON)",
          ) as HTMLTextAreaElement
        ).value,
      ).toContain('"title": "Example"'),
    );
    fireEvent.click(
      within(panel).getByRole("button", { name: /^Trigger event$/ }),
    );

    await waitFor(() => expect(within(panel).getByRole("button", { name: "Trigger event" })).toBeEnabled());
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(within(panel).getByLabelText("Event data (JSON)")).toHaveValue('{\n  "title": "Example"\n}');
    fireEvent.click(within(panel).getByRole("button", { name: "Trigger event" }));
    await waitFor(() => expect(mockSimulate).toHaveBeenCalledTimes(2));
    await waitFor(() =>
      expect(mockSimulate).toHaveBeenCalledWith({
        projectId: null,
        request: {
          subscriptionId: "esub_1",
          event: { name: "issue.created", data: { title: "Example" } },
        },
      }),
    );
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    const row = await screen.findByTestId("feed-entry");
    fireEvent.click(within(row).getByRole("button"));
    expect(within(row).getByText("sim-1")).toBeInTheDocument();
    expect(screen.getByTestId("namespace-badge")).toHaveTextContent(
      "Test",
    );
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
    openWorkspaceView("Subscriptions");
    const card = await screen.findByTestId("subscription-esub_1");
    fireEvent.click(within(card).getByRole("button"));
    fireEvent.click(within(card).getByRole("button", { name: /Pause/ }));
    await waitFor(() =>
      expect(mockSetLocalState).toHaveBeenCalledWith("esub_1", "paused"),
    );
    expect(
      await within(card).findByRole("button", { name: /Resume/ }),
    ).toBeInTheDocument();
  });

  it("keeps catalog search and selection while inspecting a definition or closing setup", async () => {
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

    openWorkspaceView("Definition");
    expect(screen.getByText("Full event definition")).toBeInTheDocument();
    const subscribe = screen.getByRole("button", { name: "Subscribe" });
    fireEvent.click(subscribe);
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    await waitFor(() => expect(subscribe).toHaveFocus());
    expect(search).toHaveValue("issue");

    fireEvent.change(search, { target: { value: "" } });
    fireEvent.click(
      within(list).getByRole("button", { name: /pull_request\.opened/ }),
    );
    expect(row).toHaveAttribute("aria-pressed", "false");
    expect(
      screen.getByRole("heading", { name: "pull_request.opened" }),
    ).toBeInTheDocument();
  });

  it("scopes the workspace to the catalog and keeps unlisted subscriptions in All events", async () => {
    mockLoadEventsCatalog.mockResolvedValue(catalog([issueCreated]));
    mockListLocal.mockResolvedValue([
      subscriptionView(),
      subscriptionView({ id: "esub_2", eventName: "issue.closed", mode: "poll", desiredState: "paused", observedState: "paused" }),
    ]);
    renderTab();
    const list = await screen.findByTestId("event-types");
    fireEvent.click(within(list).getByRole("button", { name: /issue.created/ }));
    openWorkspaceView("Subscriptions");
    await screen.findByTestId("subscription-esub_1");
    expect(screen.queryByTestId("subscription-esub_2")).not.toBeInTheDocument();
    openWorkspaceView("Definition");
    fireEvent.click(screen.getByRole("button", { name: "All events" }));
    expect(screen.getByRole("tabpanel", { name: "Received" })).toBeInTheDocument();
    openWorkspaceView("Subscriptions");
    const orphan = await screen.findByTestId("subscription-esub_2");
    fireEvent.click(within(orphan).getByRole("button"));
    expect(within(orphan).getByRole("button", { name: /Stop polling/ })).toBeInTheDocument();
    fireEvent.change(screen.getByPlaceholderText("Search event types..."), { target: { value: "does-not-exist" } });
    expect(screen.getByRole("button", { name: "All events" })).toBeInTheDocument();
  });

  it("opens All events on mobile even with an empty catalog, then returns to Browse", async () => {
    mockLoadEventsCatalog.mockResolvedValue(catalog([]));
    renderTab();
    const allEvents = await screen.findByRole("button", { name: "All events" });
    expect(screen.getByTestId("mobile-selection")).toBeEmptyDOMElement();
    fireEvent.click(allEvents);
    expect(screen.getByTestId("mobile-selection")).toHaveTextContent("all-events");
    fireEvent.click(screen.getByRole("button", { name: "Back to catalog" }));
    expect(screen.getByTestId("mobile-selection")).toBeEmptyDOMElement();
  });

  it("shows connection failures outside collapsed server details", async () => {
    mockLoadEventsCatalog.mockResolvedValue(catalog([issueCreated]));
    renderTab();
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));
    act(() => FakeEventSource.instances[0]!.onerror?.());
    expect(await screen.findByTestId("feed-status")).toHaveTextContent("Reconnecting");
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

    openWorkspaceView("Subscriptions");
    const reasonOf = (id: string) =>
      within(screen.getByTestId(`subscription-${id}`)).getByTestId(
        "subscription-termination",
      );
    await waitFor(() =>
      expect(reasonOf("esub_1")).toHaveTextContent("Access revoked"),
    );
    expect(reasonOf("esub_2")).toHaveTextContent(
      "Schema changed. Refresh the event types, then subscribe again.",
    );
    expect(reasonOf("esub_3")).toHaveTextContent("Event type removed");
    openWorkspaceView("Received");
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
    openWorkspaceView("Subscriptions");
    const suspended = await screen.findByTestId("subscription-esub_1");
    expect(within(suspended).getByTestId("delivery-state")).toHaveTextContent(
      "Suspended after repeated failures",
    );
    expect(within(suspended).getByText("http_4xx")).toBeInTheDocument();
    fireEvent.click(within(suspended).getByRole("button"));
    expect(
      within(suspended).getByText("null (replay not supported)"),
    ).toBeInTheDocument();
    expect(
      within(screen.getByTestId("subscription-esub_2")).getByTestId(
        "delivery-state",
      ),
    ).toHaveTextContent("Throttled, for about 60s");

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
    expect(await screen.findByRole("dialog")).toBeInTheDocument();
    expect(screen.getByPlaceholderText("Enter repo")).toHaveValue("octo/hello");
  });

  it("refreshes a Beta catalog from the watch and ends the watch on unmount", async () => {
    const support = { ...declaredSupport, beta: true, listChanged: true };
    mockLoadEventsCatalog.mockResolvedValue(catalog([issueCreated], { support }));
    mockWatchEventsCatalog.mockResolvedValue(undefined);
    const view = renderTab();

    await waitFor(() => expect(mockWatchEventsCatalog).toHaveBeenCalledTimes(1));
    expect(screen.queryByTestId("events-profile-badge")).not.toBeInTheDocument();
    const [serverName, signal, onChange] = mockWatchEventsCatalog.mock.calls[0]!;
    expect(serverName).toBe(SERVER);
    mockLoadEventsCatalog.mockResolvedValue(catalog([{ ...issueCreated, name: "issue.closed" }], { support }));
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
    openWorkspaceView("Subscriptions");
    const card = await screen.findByTestId("subscription-esub_1");
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));
    fireEvent.click(within(card).getByRole("button"));
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
