import { describe, expect, it } from "vitest";
import {
  assertEventsSubscribeResult,
  classifyWebhookBody,
  InvalidEventsPayloadError,
} from "../../mcp-client-manager/events-ext-guards.js";
import {
  createRpcLogRedactor,
  redactRpcMessageForLog,
  redactWebhookSecretsInText,
} from "../../mcp-client-manager/rpc-log-redaction.js";
import {
  EventsCapabilityCapture,
  resolveEventsSupport,
} from "../../mcp-client-manager/events-capability-capture.js";
import {
  CHATGPT_PROFILE,
  DRAFT_PROFILE,
  listProfileFacts,
  selectDeliveryMode,
} from "../profiles.js";
import { MemoryEventInbox } from "../memory-inbox.js";
import { buildWebhookHeaders } from "../standard-webhooks.js";
import { computeRefreshAt, EventsCoordinator } from "../coordinator.js";
import { DRAFT_PROFILE_ID } from "../profiles.js";
import type { EventsRpcPort } from "../types.js";

describe("guards", () => {
  it("refuses a subscribe result without refreshBefore instead of reading no-expiry", () => {
    expect(() => assertEventsSubscribeResult({ id: "sub_1" })).toThrow(
      InvalidEventsPayloadError
    );
    expect(
      assertEventsSubscribeResult({ id: "sub_1", refreshBefore: null })
    ).toMatchObject({ id: "sub_1", refreshBefore: null });
  });

  it("classifies webhook bodies by the top-level type discriminator", () => {
    expect(
      classifyWebhookBody({
        eventId: "e",
        name: "n",
        timestamp: "2026-09-30T00:00:00Z",
        data: {},
      }).kind
    ).toBe("event");
    expect(classifyWebhookBody({ type: "gap", cursor: "c" }).kind).toBe("gap");
    expect(classifyWebhookBody({ type: "verification", challenge: "x" }).kind).toBe(
      "verification"
    );
    expect(classifyWebhookBody({ type: "future", x: 1 })).toEqual({
      kind: "unknown-control",
      type: "future",
    });
    expect(() => classifyWebhookBody({ eventId: "e" })).toThrow(
      InvalidEventsPayloadError
    );
  });
});

describe("redaction (C8)", () => {
  const secret = "whsec_c2VudGluZWwtc2VjcmV0LXZhbHVlLTMyLWJ5dGVzISE=";

  it("returns ordinary frames by identity", () => {
    const frame = { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} };
    expect(redactRpcMessageForLog(frame)).toBe(frame);
  });

  it("redacts delivery.secret and credential-shaped callback params on any method", () => {
    const frame = {
      jsonrpc: "2.0",
      id: 1,
      method: "events/subscribe",
      params: {
        delivery: { url: "https://x.test/h?token=abc&keep=1", secret },
      },
    };
    const redacted = redactRpcMessageForLog(frame) as any;
    expect(redacted.params.delivery.secret).toBe("whsec_<redacted>");
    expect(redacted.params.delivery.url).not.toContain("abc");
    expect(redacted.params.delivery.url).toContain("keep=1");
    // The original is untouched: the wire needs the real secret.
    expect(frame.params.delivery.secret).toBe(secret);
  });

  it("redacts a secret quoted inside an error message", () => {
    const frame = {
      jsonrpc: "2.0",
      id: 3,
      error: { code: -32602, message: `refusing ${secret} now` },
    };
    expect(JSON.stringify(redactRpcMessageForLog(frame))).not.toContain(secret);
  });

  it("walks results only for correlated events/* requests", () => {
    const redact = createRpcLogRedactor();
    redact("send", { jsonrpc: "2.0", id: 7, method: "events/subscribe", params: {} });
    const echoed = redact("receive", {
      jsonrpc: "2.0",
      id: 7,
      result: { note: secret },
    });
    expect(JSON.stringify(echoed)).not.toContain(secret);
    const unrelated = { jsonrpc: "2.0", id: 8, result: { big: "x".repeat(10) } };
    expect(redact("receive", unrelated)).toBe(unrelated);
  });
});

describe("capability capture (C10)", () => {
  it("correlates handshake ids and keeps the raw declaration", () => {
    const capture = new EventsCapabilityCapture(() => 42);
    capture.observe({
      direction: "send",
      serverId: "s",
      message: { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
    } as any);
    // An unrelated response with the same shape but another id is ignored.
    capture.observe({
      direction: "receive",
      serverId: "s",
      message: { jsonrpc: "2.0", id: 2, result: { capabilities: { events: {} } } },
    } as any);
    expect(capture.read("s")).toBeUndefined();
    capture.observe({
      direction: "receive",
      serverId: "s",
      message: {
        jsonrpc: "2.0",
        id: 1,
        result: { protocolVersion: "2025-11-25", capabilities: { events: {} } },
      },
    } as any);
    expect(resolveEventsSupport(capture.read("s"))).toMatchObject({
      handshakeObserved: true,
      declared: true,
      listChanged: false,
      source: "initialize",
    });
    capture.clear("s");
    expect(resolveEventsSupport(capture.read("s")).handshakeObserved).toBe(false);
  });

  it("reads an absent events key as undeclared, not unknown", () => {
    const capture = new EventsCapabilityCapture();
    capture.observe({
      direction: "send",
      serverId: "s",
      message: { jsonrpc: "2.0", id: "d", method: "server/discover" },
    } as any);
    capture.observe({
      direction: "receive",
      serverId: "s",
      message: { jsonrpc: "2.0", id: "d", result: { capabilities: { tools: {} } } },
    } as any);
    expect(resolveEventsSupport(capture.read("s"))).toMatchObject({
      handshakeObserved: true,
      declared: false,
    });
  });
});

describe("profiles (C1)", () => {
  it("tags every field of both profiles with a provenance", () => {
    for (const profile of [DRAFT_PROFILE, CHATGPT_PROFILE]) {
      const facts = listProfileFacts(profile);
      expect(facts.length).toBeGreaterThanOrEqual(14);
      for (const fact of facts) {
        expect(["documented", "observed", "policy", "unobserved"]).toContain(
          fact.provenance.kind
        );
      }
    }
  });

  it("labels ChatGPT internals as MCPJam policy, never as ChatGPT fact", () => {
    expect(CHATGPT_PROFILE.retention.provenance.kind).toBe("policy");
    expect(CHATGPT_PROFILE.prompting.provenance.kind).toBe("policy");
    expect(CHATGPT_PROFILE.deliveryModes.value).toEqual(["webhook"]);
  });

  it("selects delivery modes in the draft's preference order", () => {
    const advertised = ["poll", "push", "webhook"];
    expect(
      selectDeliveryMode({
        profile: DRAFT_PROFILE,
        advertised,
        webhookReceiverAvailable: true,
        pushAvailable: true,
      })
    ).toBe("webhook");
    expect(
      selectDeliveryMode({
        profile: DRAFT_PROFILE,
        advertised,
        webhookReceiverAvailable: false,
        pushAvailable: true,
      })
    ).toBe("push");
    expect(
      selectDeliveryMode({
        profile: CHATGPT_PROFILE,
        advertised: ["poll"],
        webhookReceiverAvailable: true,
        pushAvailable: true,
      })
    ).toBeUndefined();
  });

  it("refreshes with a lead of max(60 s, 10%)", () => {
    expect(
      computeRefreshAt({ now: 0, refreshBefore: 60 * 60 * 1000, healthCheckIntervalMs: 1 })
    ).toBe(54 * 60 * 1000);
    expect(
      computeRefreshAt({ now: 0, refreshBefore: 2 * 60 * 1000, healthCheckIntervalMs: 1 })
    ).toBe(60 * 1000);
    expect(computeRefreshAt({ now: 10, refreshBefore: 5, healthCheckIntervalMs: 1 })).toBe(
      10
    );
  });
});

describe("failure messages are stored without signing secrets (C8)", () => {
  it("removes the secret a server quotes back in a subscribe error, with or without its prefix", async () => {
    let sent: string | undefined;
    const rpc = {
      subscribe: async (params: { delivery: { secret: string } }) => {
        sent = params.delivery.secret;
        throw new Error(
          `delivery.secret ${sent} rejected (key material ${sent.slice("whsec_".length)})`
        );
      },
    } as unknown as EventsRpcPort;
    const inbox = new MemoryEventInbox({ publicOrigin: "https://h" });
    const coordinator = new EventsCoordinator({
      rpc: async () => rpc,
      inbox: async () => inbox,
    });
    const outcome = await coordinator.step({
      id: "esub_secret",
      projectId: "p",
      environmentId: null,
      bindingKey: "b",
      serverId: "srv_1",
      profile: DRAFT_PROFILE_ID,
      eventName: "thing.happened",
      arguments: {},
      mode: "webhook",
      desiredState: "active",
      observedState: "pending",
      generation: 1,
      nextActionAt: 0,
      consecutiveFailures: 0,
    });
    expect(sent).toMatch(/^whsec_/);
    const message = String(outcome.patch.lastError?.message);
    expect(message).toContain("rejected");
    expect(message).not.toContain(sent!.slice("whsec_".length));
  });

  const pendingRecord = {
    id: "esub_secret",
    projectId: "p",
    environmentId: null,
    bindingKey: "b",
    serverId: "srv_1",
    profile: DRAFT_PROFILE_ID,
    eventName: "thing.happened",
    arguments: {},
    mode: "webhook" as const,
    desiredState: "active" as const,
    observedState: "pending" as const,
    generation: 1,
    nextActionAt: 0,
    consecutiveFailures: 0,
  };

  async function stepWith(subscribe: (secret: string) => unknown) {
    let sent = "";
    const rpc = {
      subscribe: async (params: { delivery: { secret: string } }) => {
        sent = params.delivery.secret;
        return subscribe(sent);
      },
    } as unknown as EventsRpcPort;
    const inbox = new MemoryEventInbox({ publicOrigin: "https://h" });
    const coordinator = new EventsCoordinator({
      rpc: async () => rpc,
      inbox: async () => inbox,
    });
    const outcome = await coordinator.step(pendingRecord);
    expect(sent).toMatch(/^whsec_/);
    return { outcome, sent };
  }

  it("never copies a callback error's reason into the stored kind unless the draft defines it", async () => {
    const { outcome, sent } = await stepWith((secret) => {
      throw Object.assign(new Error("callback rejected"), {
        code: -32015,
        data: { reason: secret },
      });
    });
    expect(outcome.patch.lastError?.kind).toBe("callback_error");
    expect(JSON.stringify(outcome.patch.lastError)).not.toContain(
      sent.slice("whsec_".length)
    );

    const known = await stepWith(() => {
      throw Object.assign(new Error("callback timed out"), {
        code: -32015,
        data: { reason: "timeout" },
      });
    });
    expect(known.outcome.patch.lastError?.kind).toBe("callback_timeout");
  });

  it("removes the secret from a delivery status the server reports back", async () => {
    const { outcome, sent } = await stepWith((secret) => ({
      id: "srv-sub-1",
      cursor: null,
      deliveryStatus: {
        active: false,
        lastError: `challenge_failed for ${secret}`,
        [secret.slice("whsec_".length)]: "echoed as a key",
      },
    }));
    const stored = JSON.stringify(outcome.patch.deliveryStatus);
    expect(stored).toContain("challenge_failed for");
    expect(stored).not.toContain(sent.slice("whsec_".length));
  });

  it("records a successful subscribe whose delivery status nests too deep to walk", async () => {
    let nested: unknown = "bottom";
    for (let level = 0; level < 2_500; level += 1) nested = [nested];
    const { outcome } = await stepWith(() => ({
      id: "srv-sub-1",
      cursor: null,
      deliveryStatus: { active: true, extra: nested },
    }));
    expect(outcome.patch.observedState).toBe("active");
    expect(outcome.patch.lastError).toBeUndefined();
    // Bounded: below the limit the value is dropped, not walked.
    let depth = 0;
    let level: unknown = (outcome.patch.deliveryStatus as { extra: unknown })
      .extra;
    while (Array.isArray(level)) {
      depth += 1;
      level = level[0];
    }
    expect(level).toBeNull();
    expect(depth).toBeLessThan(64);
  });

  it("redacts every whsec_ string even when the secret is not known", () => {
    expect(
      redactWebhookSecretsInText(
        "bad secret whsec_QUJDREVGR0hJSktMTU5PUA== here"
      )
    ).toBe("bad secret whsec_<redacted> here");
  });
});

describe("coordinator options (C9)", () => {
  it("reads a coordinator option passed as undefined as its default", async () => {
    const polls: unknown[] = [];
    const rpc = {
      poll: async (params: unknown) => {
        polls.push(params);
        return { events: [], cursor: "p1" };
      },
    } as unknown as EventsRpcPort;
    const inbox = new MemoryEventInbox({ publicOrigin: "https://h" });
    const coordinator = new EventsCoordinator({
      rpc: async () => rpc,
      inbox: async () => inbox,
      clock: undefined,
      maxPagesPerStep: undefined,
    });
    const outcome = await coordinator.step({
      id: "esub_1",
      projectId: "p",
      environmentId: null,
      bindingKey: "b",
      serverId: "srv_1",
      profile: DRAFT_PROFILE_ID,
      eventName: "thing.happened",
      arguments: {},
      mode: "poll",
      desiredState: "active",
      observedState: "pending",
      generation: 1,
      nextActionAt: 0,
      consecutiveFailures: 0,
    });
    expect(polls).toHaveLength(1);
    expect(outcome.patch.lastCursor).toBe("p1");
  });
});

describe("MemoryEventInbox receive (C3 table)", () => {
  async function signed(
    inbox: MemoryEventInbox,
    slotId: string,
    body: unknown,
    webhookId: string,
    options: { now?: number; subscriptionId?: string } = {}
  ) {
    const { secret } = await inbox.getSecret(slotId);
    const text = JSON.stringify(body);
    const headers = await buildWebhookHeaders({
      secrets: [secret],
      webhookId,
      timestampSeconds: Math.floor((options.now ?? Date.now()) / 1000),
      body: text,
      subscriptionId: options.subscriptionId ?? "sub_1",
    });
    return inbox.receive({ slotId, headers, body: text });
  }

  const event = (eventId: string) => ({
    eventId,
    name: "comment.created",
    timestamp: "2026-09-30T00:00:00Z",
    data: { a: 1 },
    cursor: "c1",
  });

  async function slot(inbox: MemoryEventInbox) {
    return inbox.allocateSlot({
      logicalSubscriptionId: "esub_1",
      projectId: "p",
      environmentId: null,
      bindingKey: "b",
      dispatch: true,
      idempotencyKey: crypto.randomUUID(),
    });
  }

  it("accepts a signed event on a pending slot and records the observed id", async () => {
    const inbox = new MemoryEventInbox({ publicOrigin: "https://h" });
    const { slotId } = await slot(inbox);
    const result = await signed(inbox, slotId, event("e1"), "e1", {
      subscriptionId: "sub_early",
    });
    expect(result.status).toBe(200);
    expect(inbox.slotState(slotId)).toMatchObject({
      state: "pending",
      observedSubscriptionIds: ["sub_early"],
    });
    expect(inbox.read(0).entries[0]).toMatchObject({ dispatch: "pending" });
  });

  it("echoes a signed challenge and never journals it", async () => {
    const inbox = new MemoryEventInbox({ publicOrigin: "https://h" });
    const { slotId } = await slot(inbox);
    const result = await signed(
      inbox,
      slotId,
      { type: "verification", challenge: "abc" },
      "msg_verification_1"
    );
    expect(result).toMatchObject({ status: 200, body: { challenge: "abc" } });
    expect(inbox.read(0).entries).toEqual([]);
  });

  it("dedupes, journals removed-slot deliveries without dispatch, and 410s expired slots", async () => {
    let now = Date.now();
    const inbox = new MemoryEventInbox({
      publicOrigin: "https://h",
      clock: { now: () => now },
      pendingTtlMs: 1000,
    });
    const a = await slot(inbox);
    await inbox.reconcile(a.slotId, "sub_1");
    expect((await signed(inbox, a.slotId, event("e1"), "e1", { now })).status).toBe(200);
    expect(
      (await signed(inbox, a.slotId, event("e1"), "e1", { now })).body
    ).toEqual({ duplicate: true });
    await inbox.remove(a.slotId);
    await signed(inbox, a.slotId, event("e2"), "e2", { now });
    expect(inbox.read(0).entries.map((e) => [e.eventId, e.dispatch])).toEqual([
      ["e1", "pending"],
      ["e2", "none"],
    ]);

    const b = await slot(inbox);
    now += 2000;
    expect((await signed(inbox, b.slotId, event("e3"), "e3", { now })).status).toBe(410);
  });

  it("reports an expired pending slot and never binds it", async () => {
    let now = Date.now();
    const inbox = new MemoryEventInbox({
      publicOrigin: "https://h",
      clock: { now: () => now },
      pendingTtlMs: 1000,
    });
    const { slotId, secret } = await slot(inbox);
    expect(await inbox.getSecret(slotId)).toEqual({ secret, state: "pending" });
    now += 1000;
    expect(await inbox.getSecret(slotId)).toEqual({ secret, state: "expired" });
    expect(inbox.slotState(slotId)?.state).toBe("expired");
    // Like the Durable Object's `409 slot_expired`: not resurrectable.
    await expect(inbox.reconcile(slotId, "sub_1")).rejects.toThrow(/expired/);
  });

  it("unbinds a paused slot so resume binds a new server id", async () => {
    let now = Date.now();
    const inbox = new MemoryEventInbox({
      publicOrigin: "https://h",
      clock: { now: () => now },
      pendingTtlMs: 1000,
    });
    const { slotId, secret } = await slot(inbox);
    await inbox.reconcile(slotId, "sub_1");
    expect(await inbox.reconcile(slotId, "sub_2")).toMatchObject({
      conflict: { existing: "sub_1", proposed: "sub_2" },
    });
    await inbox.unbind(slotId);
    await inbox.unbind(slotId); // idempotent
    expect(inbox.slotState(slotId)).toMatchObject({ state: "pending" });
    expect(inbox.slotState(slotId)?.serverSubscriptionId).toBeUndefined();
    // A paused subscription holds its slot: no pending expiry, same secret.
    now += 60_000;
    expect(await inbox.getSecret(slotId)).toEqual({ secret, state: "pending" });
    expect(
      (await signed(inbox, slotId, event("e1"), "e1", { now })).status
    ).toBe(200);
    expect(await inbox.reconcile(slotId, "sub_2")).toEqual({ state: "active" });
    expect(inbox.slotState(slotId)?.serverSubscriptionId).toBe("sub_2");
    await inbox.remove(slotId);
    await expect(inbox.unbind(slotId)).rejects.toThrow(/removed/);
  });

  it("quarantines a malformed signed event instead of dropping or retrying it", async () => {
    const inbox = new MemoryEventInbox({ publicOrigin: "https://h" });
    const { slotId } = await slot(inbox);
    const result = await signed(inbox, slotId, { eventId: "e1" }, "e1");
    expect(result.status).toBe(202);
    expect(inbox.read(0).entries[0]).toMatchObject({
      quarantined: true,
      dispatch: "none",
    });
  });

  it("refuses bodies over 256 KiB", async () => {
    const inbox = new MemoryEventInbox({ publicOrigin: "https://h" });
    const { slotId } = await slot(inbox);
    const result = await inbox.receive({
      slotId,
      headers: {},
      body: "x".repeat(262_145),
    });
    expect(result.status).toBe(413);
  });

  it("delivers backlog and live with no gap or duplicate", async () => {
    const inbox = new MemoryEventInbox({ publicOrigin: "https://h" });
    const { slotId } = await slot(inbox);
    await signed(inbox, slotId, event("e1"), "e1");
    const live: number[] = [];
    const { backlog } = inbox.subscribe(0, (entry) => live.push(entry.seq));
    await signed(inbox, slotId, event("e2"), "e2");
    expect([...backlog.map((entry) => entry.seq), ...live]).toEqual([1, 2]);
  });
});

describe("ChatGPT probe observations (phase 0)", () => {
  it("summarizes observations into dated observed facts and keeps shapes only", async () => {
    const { summarizeProbeObservations, callbackUrlShape } = await import(
      "../probe-observations.js"
    );
    expect(
      callbackUrlShape("https://chatgpt.example/mcp-events/cb_8f3a91c2d4e5?sig=abc")
    ).toBe("https://chatgpt.example/mcp-events/{id}?{query}");
    const facts = summarizeProbeObservations([
      {
        kind: "subscribe",
        at: "2026-10-01T10:00:00Z",
        protocolVersion: "2026-07-28",
        ttlMs: "omitted",
        secretBytes: 32,
        cursorSent: "null",
        callbackUrlShape: "https://x/{id}",
        isRefresh: false,
      },
      {
        kind: "subscribe",
        at: "2026-10-01T10:09:00Z",
        ttlMs: "omitted",
        secretBytes: 32,
        cursorSent: "null",
        callbackUrlShape: "https://x/{id}",
        isRefresh: true,
        leadMs: 60_000,
      },
      { kind: "delivery", at: "2026-10-01T10:00:01Z", variant: "verification", status: 200, echoMatched: true },
      { kind: "delivery", at: "2026-10-01T10:05:00Z", variant: "oversize", status: 413 },
      { kind: "unsubscribe", at: "2026-10-02T09:00:00Z", callbackUrlShape: "https://x/{id}" },
    ]);
    expect(facts.requestedTtlMs).toEqual({
      value: "omitted",
      provenance: { kind: "observed", date: "2026-10-01", probe: "sdk/scripts/chatgpt-events-probe.ts" },
    });
    expect(facts.secretBytes?.value).toBe(32);
    expect(facts.refreshLead?.value).toMatch(/median 60 s/);
    expect(facts.unsubscribesOnEnd?.provenance).toMatchObject({ kind: "observed", date: "2026-10-02" });
    expect(facts.deliveryResponses?.value).toEqual({ oversize: 413 });
    expect(facts.verificationEcho?.value).toBe(true);
    expect(JSON.stringify(facts)).not.toContain("whsec_");
  });

  it("reports a ttlMs of an unexpected type as it was sent", async () => {
    const { summarizeProbeObservations } = await import("../probe-observations.js");
    const facts = summarizeProbeObservations([
      {
        kind: "subscribe",
        at: "2026-10-01T10:00:00Z",
        ttlMs: { unexpectedType: "string", json: '"600000"' },
        secretBytes: 32,
        cursorSent: "null",
        callbackUrlShape: "https://x/{id}",
        isRefresh: false,
      },
    ]);
    expect(facts.requestedTtlMs?.value).toEqual({ unexpectedType: "string", json: '"600000"' });
  });
});
