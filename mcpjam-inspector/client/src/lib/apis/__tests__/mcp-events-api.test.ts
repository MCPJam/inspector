/**
 * The Events API client in LOCAL mode, plus the mode-independent pieces:
 * feed-entry normalization (hosted `dispatchState` → `dispatch`), the hosted
 * feed page, canonical JSON for the descriptor digest, and the registry-row
 * mapping.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/config", () => ({ HOSTED_MODE: false }));

const { authFetchMock } = vi.hoisted(() => ({ authFetchMock: vi.fn() }));
vi.mock("@/lib/session-token", () => ({
  authFetch: authFetchMock,
  addTokenToUrl: (url: string) => url,
  resetTokenCache: () => {},
}));

import {
  EventsApiError,
  buildHostedEventDescriptor,
  canonicalJson,
  createLocalEventSubscription,
  fetchHostedEventsFeed,
  hostedEventsStreamUrl,
  hostedSubscriptionRowToView,
  loadEventsCatalog,
  normalizeFeedEntry,
  simulateEvent,
} from "../mcp-events-api";

function jsonResponse(body: unknown, status = 200) {
  return {
    ok: status < 400,
    status,
    json: async () => body,
  } as unknown as Response;
}

const bodyOf = (index: number) =>
  JSON.parse(
    (authFetchMock.mock.calls[index]![1] as RequestInit).body as string,
  );

describe("mcp-events-api (local)", () => {
  beforeEach(() => {
    authFetchMock.mockReset();
  });

  it("reads support first and skips events/list for an undeclared server", async () => {
    authFetchMock.mockResolvedValueOnce(
      jsonResponse({
        support: {
          handshakeObserved: true,
          declared: false,
          listChanged: false,
        },
        rawCapabilities: { tools: {} },
        protocolVersion: "2026-07-28",
      }),
    );
    const catalog = await loadEventsCatalog("github");
    expect(catalog).toEqual({
      events: [],
      support: { handshakeObserved: true, declared: false, listChanged: false },
      rawCapabilities: { tools: {} },
      protocolVersion: "2026-07-28",
    });
    expect(authFetchMock).toHaveBeenCalledTimes(1);
    expect(authFetchMock.mock.calls[0]![0]).toBe("/api/mcp/events/support");
    expect(bodyOf(0)).toEqual({ serverId: "github" });
  });

  it("lists events for a declared server, keeping the handshake details", async () => {
    authFetchMock
      .mockResolvedValueOnce(
        jsonResponse({
          support: {
            handshakeObserved: true,
            declared: true,
            listChanged: true,
          },
          rawCapabilities: { events: {} },
          protocolVersion: "2026-07-28",
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          events: [{ name: "tick", delivery: ["poll"] }],
          support: {
            handshakeObserved: true,
            declared: true,
            listChanged: true,
          },
        }),
      );
    const catalog = await loadEventsCatalog("github", "cursor-2");
    expect(catalog.events).toEqual([{ name: "tick", delivery: ["poll"] }]);
    expect(catalog.rawCapabilities).toEqual({ events: {} });
    expect(catalog.protocolVersion).toBe("2026-07-28");
    expect(authFetchMock.mock.calls[1]![0]).toBe("/api/mcp/events/list");
    expect(bodyOf(1)).toEqual({ serverId: "github", cursor: "cursor-2" });
  });

  it("keeps the route's error code on failure", async () => {
    authFetchMock.mockResolvedValueOnce(
      jsonResponse(
        {
          code: "EVENTS_INVALID_PAYLOAD",
          message: "arguments.repo is required",
        },
        400,
      ),
    );
    const error = await createLocalEventSubscription({
      serverId: "github",
      eventName: "issue.created",
      arguments: {},
      mode: "poll",
      profile: "draft@28ec35e",
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(EventsApiError);
    expect(error).toMatchObject({
      code: "EVENTS_INVALID_PAYLOAD",
      message: "arguments.repo is required",
      status: 400,
    });
  });

  it("returns a local simulation's journalled entry", async () => {
    authFetchMock.mockResolvedValueOnce(
      jsonResponse({
        entry: {
          seq: 4,
          kind: "event",
          origin: "simulation",
          namespace: "simulation",
          logicalSubscriptionId: "esub_1",
          receivedAt: 1,
        },
      }),
    );
    const result = await simulateEvent({
      projectId: null,
      request: { subscriptionId: "esub_1", event: { data: {} } },
    });
    expect(result.entry?.seq).toBe(4);
    expect(authFetchMock.mock.calls[0]![0]).toBe("/api/mcp/events/simulate");
  });
});

describe("feed entries", () => {
  it("normalizes a hosted FeedEntry into the view", () => {
    expect(
      normalizeFeedEntry({
        seq: 9,
        kind: "event",
        origin: "webhook",
        namespace: "live",
        logicalSubscriptionId: "esub_1",
        slotId: null,
        receivedAt: 5,
        dispatchState: "pending",
        dispatchOutcome: "scheduled",
      }),
    ).toEqual({
      seq: 9,
      kind: "event",
      origin: "webhook",
      namespace: "live",
      logicalSubscriptionId: "esub_1",
      receivedAt: 5,
      dispatch: "pending",
      dispatchOutcome: "scheduled",
    });
    expect(normalizeFeedEntry({ kind: "event" })).toBeNull();
    expect(normalizeFeedEntry("nope")).toBeNull();
  });

  it("reads a hosted feed page with a bearer token and reports gaps", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        entries: [
          {
            seq: 12,
            kind: "event",
            origin: "webhook",
            namespace: "live",
            logicalSubscriptionId: "esub_1",
            receivedAt: 1,
            dispatchState: "acked",
          },
        ],
        nextAfter: 12,
        gap: { fromSeq: 3, toSeq: 10 },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    try {
      const page = await fetchHostedEventsFeed({
        feedUrl: "https://hooks.mcpjam.com/i/inb_1/deliveries",
        token: "tok",
        after: 2,
      });
      expect(fetchMock).toHaveBeenCalledWith(
        "https://hooks.mcpjam.com/i/inb_1/deliveries?after=2&limit=200",
        { headers: { Authorization: "Bearer tok" } },
      );
      expect(page.entries[0]).toMatchObject({ seq: 12, dispatch: "acked" });
      expect(page.nextAfter).toBe(12);
      expect(page.gap).toEqual({ fromSeq: 3, toSeq: 10 });

      fetchMock.mockResolvedValueOnce(
        jsonResponse({ error: "unauthorized", reason: "expired" }, 401),
      );
      await expect(
        fetchHostedEventsFeed({
          feedUrl: "https://h/i/x/deliveries",
          token: "t",
          after: 0,
        }),
      ).rejects.toMatchObject({ code: "unauthorized", status: 401 });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("puts the viewer token on the stream URL (EventSource cannot set headers)", () => {
    expect(
      hostedEventsStreamUrl(
        "https://hooks.mcpjam.com/i/inb_1/stream",
        7,
        "a b",
      ),
    ).toBe("https://hooks.mcpjam.com/i/inb_1/stream?after=7&token=a+b");
  });
});

describe("hosted registry helpers", () => {
  it("maps a Convex row to the tab's subscription view", () => {
    expect(
      hostedSubscriptionRowToView({
        _id: "sub_1",
        logicalId: "esub_1",
        projectId: "proj_1",
        binding: { serverId: "srv_1" },
        profile: "chatgpt@2026-09-30",
        eventName: "issue.created",
        mode: "webhook",
        desiredState: "active",
        observedState: "paused_auth",
        generation: 3,
        refreshBefore: null,
      }),
    ).toEqual({
      id: "sub_1",
      logicalId: "esub_1",
      serverId: "srv_1",
      eventName: "issue.created",
      arguments: {},
      mode: "webhook",
      profile: "chatgpt@2026-09-30",
      desiredState: "active",
      observedState: "paused_auth",
      generation: 3,
      refreshBefore: null,
      consecutiveFailures: 0,
      locality: "hosted",
    });
  });

  it("serializes canonical JSON with sorted keys and no undefined", () => {
    expect(
      canonicalJson({ b: 1, a: [undefined, -0, { d: undefined, c: "x" }] }),
    ).toBe('{"a":[null,0,{"c":"x"}],"b":1}');
  });

  it("digests the descriptor independent of key order", async () => {
    const a = await buildHostedEventDescriptor({
      name: "tick",
      delivery: ["poll"],
      payloadSchema: { type: "object" },
    });
    const b = await buildHostedEventDescriptor({
      payloadSchema: { type: "object" },
      delivery: ["poll"],
      name: "tick",
    });
    expect(a?.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(a?.hash).toBe(b?.hash);
    expect(a).toMatchObject({
      delivery: ["poll"],
      payloadSchema: { type: "object" },
    });
  });
});
