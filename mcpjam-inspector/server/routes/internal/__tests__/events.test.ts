import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createInternalEventsRouter } from "../events.js";

const TOKEN = "dispatch-token-0123456789abcdef0123456789";

const payloadSchema = {
  type: "object",
  properties: {
    document_id: { type: "string" },
    comment_id: { type: "string" },
    text: { type: "string" },
  },
  required: ["document_id", "comment_id", "text"],
};

function delivery(
  deliveryKey: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    seq: 1,
    deliveryKey,
    kind: "event",
    slotId: "slot_1",
    logicalSubscriptionId: "esub_1",
    projectId: "proj_1",
    environmentId: null,
    bindingKey: "b".repeat(64),
    origin: "webhook",
    namespace: "live",
    eventId: `evt_${deliveryKey}`,
    name: "comment.created",
    timestamp: "2026-09-30T00:00:00Z",
    data: { document_id: "d1", comment_id: "c1", text: "hello" },
    cursor: null,
    receivedAt: 1,
    ...overrides,
  };
}

function setup(options: { descriptor?: unknown; getSubscription?: () => Promise<unknown> } = {}) {
  const enqueue = vi.fn(async (request: { deliveries: Array<{ deliveryKey: string }> }) => ({
    results: request.deliveries.map((row) => ({
      deliveryKey: row.deliveryKey,
      outcome: "scheduled" as const,
      runIds: [`run_${row.deliveryKey}`],
    })),
  }));
  const getSubscription = vi.fn(
    options.getSubscription ??
      (async () => ({
        _id: "sub_doc_1",
        logicalId: "esub_1",
        projectId: "proj_1",
        descriptor: options.descriptor ?? {
          hash: "h1",
          payloadSchema,
          delivery: ["webhook"],
        },
      })),
  );
  const kick = vi.fn();
  const router = createInternalEventsRouter({
    backend: { enqueue, getSubscription } as never,
    kick,
  });
  const post = (body: unknown, headers: Record<string, string> = { "x-events-inbox-token": TOKEN }) =>
    router.request("/enqueue", {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    });
  return { router, enqueue, getSubscription, kick, post };
}

describe("POST /api/internal/events/enqueue", () => {
  let saved: string | undefined;
  beforeEach(() => {
    saved = process.env.EVENTS_INBOX_DISPATCH_TOKEN;
    process.env.EVENTS_INBOX_DISPATCH_TOKEN = TOKEN;
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.EVENTS_INBOX_DISPATCH_TOKEN;
    else process.env.EVENTS_INBOX_DISPATCH_TOKEN = saved;
  });

  it("401s without the dispatch token, with a wrong one, and when unconfigured", async () => {
    const { post, enqueue } = setup();
    const body = { inboxId: "inbox_1", deliveries: [delivery("k1")] };
    expect((await post(body, {})).status).toBe(401);
    expect((await post(body, { "x-events-inbox-token": `${TOKEN}x` })).status).toBe(401);
    delete process.env.EVENTS_INBOX_DISPATCH_TOKEN;
    expect((await post(body)).status).toBe(401);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("quarantines payloads failing the descriptor's schema without forwarding them", async () => {
    const { post, enqueue, kick } = setup();
    const response = await post({
      inboxId: "inbox_1",
      deliveries: [
        delivery("k1"),
        delivery("k2", { data: { document_id: "d1" } }), // missing fields
        delivery("k3"),
        delivery("k4", { kind: "gap", data: undefined, eventId: undefined }),
      ],
    });
    expect(response.status).toBe(200);
    const { results } = await response.json();
    // Request order is preserved, one result per delivery.
    expect(results.map((row: { deliveryKey: string }) => row.deliveryKey)).toEqual([
      "k1",
      "k2",
      "k3",
      "k4",
    ]);
    expect(results[1]).toEqual({ deliveryKey: "k2", outcome: "quarantined", runIds: [] });
    expect(results[0].outcome).toBe("scheduled");
    // The malformed one never reached the backend; the rest did, in order.
    const forwarded = enqueue.mock.calls[0]![0] as unknown as {
      inboxId: string;
      deliveries: Array<Record<string, unknown>>;
    };
    expect(forwarded.inboxId).toBe("inbox_1");
    expect(forwarded.deliveries.map((row) => row.deliveryKey)).toEqual(["k1", "k3", "k4"]);
    expect(kick).toHaveBeenCalledTimes(1);
  });

  it("passes slotless, terminated and keeper-report rows through untouched", async () => {
    const { post, enqueue } = setup();
    const rows = [
      // A slotless poll append carries `slotId: null`.
      delivery("k1", { slotId: null, origin: "poll" }),
      // A terminated control row carries `error`, and no event payload.
      delivery("k2", {
        kind: "terminated",
        data: undefined,
        eventId: undefined,
        name: undefined,
        error: { code: -32011, message: "gone" },
      }),
      // A keeper report carries `data`, plus a field this route never heard of.
      delivery("k3", {
        kind: "late_delivery_after_removal",
        data: { webhookId: "msg_1" },
        futureField: { anything: true },
      }),
    ];
    const response = await post({ inboxId: "inbox_1", deliveries: rows });
    expect(response.status).toBe(200);
    const forwarded = enqueue.mock.calls[0]![0] as unknown as {
      deliveries: Array<Record<string, unknown>>;
    };
    expect(forwarded.deliveries).toEqual(JSON.parse(JSON.stringify(rows)));
    expect(forwarded.deliveries[0]).toHaveProperty("slotId", null);
    expect(forwarded.deliveries[1]).toHaveProperty("error", { code: -32011, message: "gone" });
  });

  it("quarantines a row the backend would refuse, without failing the batch", async () => {
    const { post, enqueue } = setup();
    const broken = delivery("k2");
    delete broken.projectId;
    const response = await post({ inboxId: "inbox_1", deliveries: [delivery("k1"), broken] });
    expect(response.status).toBe(200);
    expect((await response.json()).results).toEqual([
      { deliveryKey: "k1", outcome: "scheduled", runIds: ["run_k1"] },
      { deliveryKey: "k2", outcome: "quarantined", runIds: [] },
    ]);
    const forwarded = enqueue.mock.calls[0]![0] as unknown as {
      deliveries: Array<Record<string, unknown>>;
    };
    expect(forwarded.deliveries.map((row) => row.deliveryKey)).toEqual(["k1"]);
  });

  it("reads each subscription's descriptor once per batch", async () => {
    const { post, getSubscription } = setup();
    await post({ inboxId: "inbox_1", deliveries: [delivery("k1"), delivery("k2")] });
    expect(getSubscription).toHaveBeenCalledTimes(1);
    expect(getSubscription).toHaveBeenCalledWith("esub_1");
  });

  it("forwards everything when the descriptor has no payload schema", async () => {
    const { post, enqueue } = setup({ descriptor: { hash: "h", delivery: ["poll"] } });
    const response = await post({
      inboxId: "inbox_1",
      deliveries: [delivery("k1", { data: { anything: true } })],
    });
    expect((await response.json()).results[0].outcome).toBe("scheduled");
    expect(enqueue).toHaveBeenCalledTimes(1);
  });

  it("does not kick the executor when nothing was scheduled", async () => {
    const { post, kick } = setup();
    await post({
      inboxId: "inbox_1",
      deliveries: [delivery("k2", { data: { nope: 1 } })],
    });
    expect(kick).not.toHaveBeenCalled();
  });

  it("leaves the batch pending (non-200) when descriptors cannot be read", async () => {
    const { post, enqueue } = setup({
      getSubscription: async () => {
        throw new Error("backend down");
      },
    });
    const response = await post({ inboxId: "inbox_1", deliveries: [delivery("k1")] });
    expect(response.status).toBe(503);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("rejects a malformed body", async () => {
    const { post } = setup();
    expect((await post({ inboxId: "inbox_1", deliveries: [{ nope: true }] })).status).toBe(400);
    expect((await post({ deliveries: [] })).status).toBe(400);
  });
});

describe("POST /api/internal/events/dispatch", () => {
  let saved: string | undefined;
  beforeEach(() => {
    saved = process.env.INSPECTOR_SERVICE_TOKEN;
    process.env.INSPECTOR_SERVICE_TOKEN = "service-token";
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.INSPECTOR_SERVICE_TOKEN;
    else process.env.INSPECTOR_SERVICE_TOKEN = saved;
  });

  it("rings the executor behind the service token", async () => {
    const { router, kick } = setup();
    const refused = await router.request("/dispatch", { method: "POST" });
    expect(refused.status).toBe(401);
    const accepted = await router.request("/dispatch", {
      method: "POST",
      headers: { "x-inspector-service-token": "service-token" },
    });
    expect(accepted.status).toBe(202);
    expect(kick).toHaveBeenCalledTimes(1);
  });
});
