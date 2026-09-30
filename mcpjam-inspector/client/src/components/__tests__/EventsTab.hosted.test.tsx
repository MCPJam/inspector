/**
 * The Events tab in HOSTED mode: the registry is Convex (called from the
 * client), and the feed is the public inbox read with a short-lived viewer
 * token (contract C7). Hosted feed messages are one FeedEntry each (with
 * `dispatchState`), plus named events (`gap`, `dispatch`, `expired`, …).
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

vi.mock("@/lib/config", () => ({ HOSTED_MODE: true }));

const mockLoadEventsCatalog = vi.fn();
const mockFetchViewerToken = vi.fn();
const mockFetchSlotState = vi.fn();
const mutations = new Map<unknown, ReturnType<typeof vi.fn>>();
let hostedRows: unknown[] | undefined = [];

vi.mock("@/lib/apis/mcp-events-api", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  loadEventsCatalog: (...args: unknown[]) => mockLoadEventsCatalog(...args),
  fetchEventsViewerToken: (...args: unknown[]) => mockFetchViewerToken(...args),
  fetchEventsSlotState: (...args: unknown[]) => mockFetchSlotState(...args),
  fetchHostedEventsFeed: vi.fn(),
  resolveHostedEventsServerId: () => "srv_convex_1",
  buildHostedEventDescriptor: async (descriptor: { delivery: string[] }) => ({
    hash: "descriptor-hash",
    delivery: descriptor.delivery,
  }),
}));

vi.mock("convex/react", () => ({
  useQuery: (_ref: unknown, args: unknown) =>
    args === "skip" ? undefined : hostedRows,
  useMutation: (ref: unknown) => {
    if (!mutations.has(ref)) mutations.set(ref, vi.fn().mockResolvedValue({}));
    return mutations.get(ref);
  },
}));

vi.mock("@/lib/analytics", () => ({ track: vi.fn() }));

vi.mock("../ui/three-panel-layout", () => ({
  ThreePanelLayout: ({
    sidebar,
    content,
  }: {
    sidebar: React.ReactNode;
    content: React.ReactNode;
  }) => (
    <div>
      <div>{sidebar}</div>
      <div>{content}</div>
    </div>
  ),
}));

vi.mock("@/components/ui/json-editor", () => ({
  JsonEditor: (props: { value: unknown }) => (
    <div data-testid="json-editor">{JSON.stringify(props.value)}</div>
  ),
}));

import { EventsTab } from "../EventsTab";
import { EVENT_SUBSCRIPTIONS_API } from "@/lib/apis/mcp-events-api";

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  onmessage: ((ev: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  onopen: (() => void) | null = null;
  closed = false;
  private listeners = new Map<string, Array<(ev: { data: string }) => void>>();
  constructor(public readonly url: string) {
    FakeEventSource.instances.push(this);
  }
  addEventListener(name: string, listener: (ev: { data: string }) => void) {
    this.listeners.set(name, [...(this.listeners.get(name) ?? []), listener]);
  }
  close() {
    this.closed = true;
  }
  message(data: unknown) {
    act(() => this.onmessage?.({ data: JSON.stringify(data) }));
  }
  named(name: string, data: unknown) {
    act(() => {
      for (const listener of this.listeners.get(name) ?? []) {
        listener({ data: JSON.stringify(data) });
      }
    });
  }
}

const serverConfig = () =>
  ({
    transportType: "streamable-http",
    url: "https://example.com/mcp",
  }) as unknown as MCPServerConfig;

const viewerToken = (token: string) => ({
  inboxId: "inb_1",
  token,
  expiresAt: Date.now() + 10 * 60_000,
  feedUrl: "https://hooks.mcpjam.com/i/inb_1/deliveries",
  streamUrl: "https://hooks.mcpjam.com/i/inb_1/stream",
});

const hostedRow = {
  _id: "sub_convex_1",
  logicalId: "esub_hosted_1",
  projectId: "proj_1",
  binding: { serverId: "srv_convex_1" },
  locality: "hosted",
  profile: "chatgpt@2026-09-30",
  eventName: "issue.created",
  arguments: {},
  mode: "webhook",
  desiredState: "active",
  observedState: "active",
  generation: 1,
  refreshBefore: null,
  callbackUrl: "https://hooks.mcpjam.com/i/inb_1/s/slot_1",
  consecutiveFailures: 0,
};

describe("EventsTab (hosted)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mutations.clear();
    FakeEventSource.instances = [];
    Object.assign(globalThis, { EventSource: FakeEventSource });
    hostedRows = [hostedRow];
    mockLoadEventsCatalog.mockResolvedValue({
      events: [
        {
          name: "issue.created",
          delivery: ["poll", "webhook"],
          inputSchema: { type: "object", properties: {} },
        },
      ],
      support: { handshakeObserved: true, declared: true, listChanged: false },
      protocolVersion: "2026-07-28",
    });
    mockFetchViewerToken
      .mockResolvedValueOnce(viewerToken("tok_1"))
      .mockResolvedValueOnce(viewerToken("tok_2"));
  });

  it("opens the inbox stream with a viewer token and reconnects with a fresh one", async () => {
    render(
      <EventsTab
        serverConfig={serverConfig()}
        serverName="github"
        projectId="proj_1"
      />,
    );

    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));
    expect(mockFetchViewerToken).toHaveBeenCalledWith("proj_1");
    const first = FakeEventSource.instances[0]!;
    expect(first.url).toBe(
      "https://hooks.mcpjam.com/i/inb_1/stream?after=0&token=tok_1",
    );

    // Unnamed messages are one hosted FeedEntry each; `dispatchState` is
    // normalized to the view's `dispatch`.
    first.message({
      seq: 3,
      kind: "event",
      origin: "webhook",
      namespace: "live",
      logicalSubscriptionId: "esub_hosted_1",
      slotId: null,
      eventId: "evt_3",
      name: "issue.created",
      receivedAt: Date.now(),
      dispatchState: "acked",
      data: { title: "hi" },
    });
    const entry = await screen.findByTestId("feed-entry");
    expect(within(entry).getByText("evt_3")).toBeInTheDocument();
    expect(within(entry).getByText("acked")).toBeInTheDocument();

    // A dispatch update for that entry.
    first.named("dispatch", {
      seq: 3,
      dispatchState: "done",
      outcome: "scheduled",
    });
    expect(
      await within(entry).findByText("done (scheduled)"),
    ).toBeInTheDocument();

    // A gap in the inbox's retained history is said out loud.
    first.named("gap", { fromSeq: 1, toSeq: 2 });
    expect(
      await screen.findByText(/Entries #1 to #2 are no longer/),
    ).toBeInTheDocument();

    // The token expired: re-authorize and continue from the last seq.
    first.named("expired", {});
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(2));
    expect(first.closed).toBe(true);
    expect(mockFetchViewerToken).toHaveBeenCalledTimes(2);
    expect(FakeEventSource.instances[1]!.url).toBe(
      "https://hooks.mcpjam.com/i/inb_1/stream?after=3&token=tok_2",
    );
  });

  it("creates hosted subscriptions in the Convex registry", async () => {
    render(
      <EventsTab
        serverConfig={serverConfig()}
        serverName="github"
        projectId="proj_1"
      />,
    );

    // The registry row for this server renders.
    const card = await screen.findByTestId("subscription-sub_convex_1");
    expect(within(card).getByText("ChatGPT (2026-09-30)")).toBeInTheDocument();

    // Hosted webhooks need no acknowledgement: they use the public inbox.
    fireEvent.click(screen.getByRole("radio", { name: /Webhook/ }));
    expect(
      screen.queryByRole("checkbox", { name: /local development receiver/ }),
    ).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Subscribe/ }));

    const create = mutations.get(EVENT_SUBSCRIPTIONS_API.create)!;
    await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    expect(create).toHaveBeenCalledWith({
      projectId: "proj_1",
      serverId: "srv_convex_1",
      eventName: "issue.created",
      arguments: {},
      mode: "webhook",
      profile: "draft@28ec35e",
      locality: "hosted",
      descriptor: { hash: "descriptor-hash", delivery: ["poll", "webhook"] },
      protocolVersion: "2026-07-28",
    });
  });

  it("pauses through setDesiredState and loads slot rejections", async () => {
    mockFetchSlotState.mockResolvedValue({
      state: "active",
      rejections: [
        {
          reason: "stale_timestamp",
          slotId: "slot_1",
          at: Date.now(),
          headerNames: ["webhook-timestamp"],
          bodyBytes: 64,
        },
      ],
    });
    render(
      <EventsTab
        serverConfig={serverConfig()}
        serverName="github"
        projectId="proj_1"
      />,
    );

    const card = await screen.findByTestId("subscription-sub_convex_1");
    fireEvent.click(within(card).getByRole("button", { name: /Pause/ }));
    const setState = mutations.get(EVENT_SUBSCRIPTIONS_API.setDesiredState)!;
    await waitFor(() =>
      expect(setState).toHaveBeenCalledWith({
        subscriptionId: "sub_convex_1",
        desiredState: "paused",
      }),
    );

    fireEvent.click(within(card).getByRole("button", { name: /Check slot/ }));
    await waitFor(() =>
      expect(mockFetchSlotState).toHaveBeenCalledWith({
        projectId: "proj_1",
        subscriptionId: "sub_convex_1",
      }),
    );
    expect(await screen.findByText("stale_timestamp")).toBeInTheDocument();
  });
});
