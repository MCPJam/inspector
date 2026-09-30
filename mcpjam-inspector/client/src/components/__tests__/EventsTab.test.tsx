/**
 * The Events tab (MCP Events draft extension) in LOCAL mode: the catalog,
 * the subscribe form, profiles, the local webhook acknowledgement, and the
 * SSE feed (`/api/mcp/events/stream` frames), including untrusted event data.
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
const mockListLocal = vi.fn();
const mockCreateLocal = vi.fn();
const mockSetLocalState = vi.fn();
const mockSimulate = vi.fn();
const mockTrack = vi.fn();

vi.mock("@/lib/apis/mcp-events-api", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  loadEventsCatalog: (...args: unknown[]) => mockLoadEventsCatalog(...args),
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

vi.mock("convex/react", () => ({
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
  }: {
    sidebar: React.ReactNode;
    content: React.ReactNode;
  }) => (
    <div>
      <div data-testid="events-sidebar">{sidebar}</div>
      <div data-testid="events-content">{content}</div>
    </div>
  ),
}));

vi.mock("@/components/ui/json-editor", () => ({
  JsonEditor: (props: { value: unknown }) => (
    <div data-testid="json-editor">{JSON.stringify(props.value)}</div>
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
      screen.getByText(/capabilities\.events not declared/),
    ).toBeInTheDocument();
    // Labelled Draft, and the raw handshake capabilities stay inspectable.
    expect(screen.getByTestId("events-draft-badge")).toHaveTextContent(
      "Draft · 28ec35e",
    );
    expect(screen.getByText("Raw capabilities")).toBeInTheDocument();
    // Nothing subscribes to the feed of a server that declares nothing.
    expect(FakeEventSource.instances).toHaveLength(0);
    expect(mockListLocal).not.toHaveBeenCalled();
    expect(mockTrack).toHaveBeenCalledWith("events_tab_viewed", {
      location: "events_tab",
    });
  });

  it("lists the declared event types with their delivery modes", async () => {
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
    expect(within(list).getAllByText("webhook")).toHaveLength(2);
    expect(within(list).getAllByText("poll")).toHaveLength(1);
    expect(
      screen.getByText("capabilities.events declared"),
    ).toBeInTheDocument();
    expect(mockLoadEventsCatalog).toHaveBeenCalledWith(SERVER);
  });

  it("builds the subscribe form from inputSchema and posts the local body", async () => {
    mockLoadEventsCatalog.mockResolvedValue(catalog([issueCreated]));
    mockCreateLocal.mockResolvedValue(subscriptionView({ mode: "poll" }));
    renderTab();

    const repo = await screen.findByPlaceholderText("Enter repo");
    fireEvent.change(repo, { target: { value: "octo/hello" } });
    expect(screen.getByRole("radio", { name: /Poll/ })).toBeChecked();
    fireEvent.change(screen.getByLabelText("maxAgeMs (optional)"), {
      target: { value: "60000" },
    });
    fireEvent.click(screen.getByRole("checkbox", { name: /No expiry/ }));
    fireEvent.click(screen.getByRole("button", { name: /Subscribe/ }));

    await waitFor(() => expect(mockCreateLocal).toHaveBeenCalledTimes(1));
    expect(mockCreateLocal).toHaveBeenCalledWith({
      serverId: SERVER,
      eventName: "issue.created",
      arguments: { repo: "octo/hello" },
      mode: "poll",
      profile: "draft@28ec35e",
      maxAgeMs: 60000,
      ttlMs: null,
    });
    // The created subscription shows up in the list.
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

    const raw = await screen.findByLabelText("Arguments JSON");
    fireEvent.change(raw, { target: { value: '{"every":"1m"}' } });
    fireEvent.click(screen.getByRole("button", { name: /Subscribe/ }));
    await waitFor(() =>
      expect(mockCreateLocal).toHaveBeenCalledWith(
        expect.objectContaining({ arguments: { every: "1m" }, mode: "poll" }),
      ),
    );
  });

  it("offers only webhook under the ChatGPT profile", async () => {
    mockLoadEventsCatalog.mockResolvedValue(catalog([issueCreated]));
    renderTab();

    expect(
      await screen.findByRole("radio", { name: /Poll/ }),
    ).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: /Push/ })).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Events profile"), {
      target: { value: "chatgpt@2026-09-30" },
    });

    expect(screen.queryByRole("radio", { name: /Poll/ })).toBeNull();
    expect(screen.queryByRole("radio", { name: /Push/ })).toBeNull();
    expect(screen.getByRole("radio", { name: /Webhook/ })).toBeChecked();
  });

  it("requires the development-receiver acknowledgement for a local webhook", async () => {
    mockLoadEventsCatalog.mockResolvedValue(
      catalog([{ ...issueCreated, delivery: ["webhook"] }]),
    );
    mockCreateLocal.mockResolvedValue(
      subscriptionView({ overrides: ["insecure-local-receiver"] }),
    );
    renderTab();

    fireEvent.change(await screen.findByPlaceholderText("Enter repo"), {
      target: { value: "octo/hello" },
    });
    const subscribe = screen.getByRole("button", { name: /Subscribe/ });
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
    const card = await screen.findByTestId("subscription-esub_1");
    expect(within(card).getByText("srv-sub-other")).toBeInTheDocument();
    expect(within(card).getByText(/Callback returned 500/)).toBeInTheDocument();
    expect(within(card).getByTestId("observed-state")).toHaveTextContent(
      "Active",
    );

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
    expect(within(entry).getByTestId("namespace-badge")).toHaveTextContent(
      "simulation",
    );
    expect(within(entry).getByText("ID conflict")).toBeInTheDocument();
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

    const data = await screen.findByTestId("event-data");
    expect(data.textContent).toContain(JSON.stringify(payload));
    expect(data.textContent).toContain("**bold**");
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("a[href^='javascript']")).toBeNull();
    expect(
      (window as unknown as { __eventsPwned?: number }).__eventsPwned,
    ).toBeUndefined();
  });

  it("simulates an event and shows the journalled entry", async () => {
    mockLoadEventsCatalog.mockResolvedValue(catalog([issueCreated]));
    mockListLocal.mockResolvedValue([subscriptionView()]);
    mockSimulate.mockResolvedValue({
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

    const panel = await screen.findByTestId("simulate-panel");
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
      within(panel).getByRole("button", { name: /Send simulated event/ }),
    );

    await waitFor(() =>
      expect(mockSimulate).toHaveBeenCalledWith({
        projectId: null,
        request: {
          subscriptionId: "esub_1",
          event: { name: "issue.created", data: { title: "Example" } },
        },
      }),
    );
    expect(await screen.findByText("sim-1")).toBeInTheDocument();
    expect(screen.getByTestId("namespace-badge")).toHaveTextContent(
      "simulation",
    );
  });

  it("pauses a subscription through the local route", async () => {
    mockLoadEventsCatalog.mockResolvedValue(catalog([issueCreated]));
    mockListLocal.mockResolvedValue([subscriptionView()]);
    mockSetLocalState.mockResolvedValue(
      subscriptionView({ desiredState: "paused", observedState: "paused" }),
    );
    renderTab();

    const card = await screen.findByTestId("subscription-esub_1");
    fireEvent.click(within(card).getByRole("button", { name: /Pause/ }));
    await waitFor(() =>
      expect(mockSetLocalState).toHaveBeenCalledWith("esub_1", "paused"),
    );
    expect(
      await within(card).findByRole("button", { name: /Resume/ }),
    ).toBeInTheDocument();
  });
});
