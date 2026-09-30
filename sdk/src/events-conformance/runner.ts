/**
 * The MCP Events conformance runner (plan phase 3).
 *
 * Runs against an ALREADY-CONNECTED `MCPClientManager` (so CLI, inspector and
 * tests reuse their own connection setup) and, for the webhook checks, a
 * receiver the server can reach (`startEventsConformanceReceiver`). Every
 * subscription it creates is unsubscribed before it returns.
 *
 * Nothing here invents subscription arguments: an event type whose
 * `inputSchema` requires fields the caller did not supply is skipped as
 * `could-not-run`, naming the fields — arguments are server-defined, and a
 * made-up filter could subscribe to somebody's real data.
 */

import { classifyEventsRpcError } from "../mcp-client-manager/events-ext-guards.js";
import type {
  EventDescriptorWire,
  EventsSubscribeResultWire,
} from "../mcp-client-manager/events-ext-schemas.js";
import { EVENTS_SUBSCRIPTION_ID_META_KEY } from "../mcp-client-manager/events-ext-schemas.js";
import { generateWebhookSecret } from "../mcp-client-manager/events-ext.js";
import type { MCPClientManager } from "../mcp-client-manager/MCPClientManager.js";
import { EVENT_DELIVERY_MODES } from "../mcp-client-manager/events-ext-schemas.js";
import { CHATGPT_PROFILE_ID, getEventsProfile, type EventsProfileId } from "../events/profiles.js";
import type { EventsConformanceReceiver } from "./receiver.js";
import {
  EVENTS_CHECK_IDS,
  type EventsCheckId,
  type EventsCheckResult,
  type EventsCheckStrength,
  type EventsConformanceResult,
} from "./types.js";

export interface EventsConformanceConfig {
  manager: MCPClientManager;
  serverId: string;
  profile: EventsProfileId;
  /** Where webhook checks deliver. Absent ⇒ webhook checks cannot run. */
  receiver?: EventsConformanceReceiver;
  /** Subscription arguments per event name. */
  eventArguments?: Record<string, Record<string, unknown>>;
  /** Cause one matching event (e.g. call a tool). Needed for delivery checks. */
  triggerEvent?: (eventName: string, args: Record<string, unknown>) => Promise<void>;
  /** How long to wait for a delivery after triggering. Default 5 s. */
  waitForEventMs?: number;
  /** Selected checks; default = all except `events-push-heartbeat`. */
  checkIds?: EventsCheckId[];
  /** `events-push-heartbeat` wait window. Default 65 s. */
  pushHeartbeatWaitMs?: number;
}

const TITLES: Record<EventsCheckId, string> = {
  "events-capability-declared": "Server declares top-level capabilities.events",
  "events-list-shape": "events/list returns valid descriptors",
  "events-poll-null-cursor": "A null-cursor poll starts from now",
  "events-subscribe-rejects-http-callback": "Non-https callback URLs are rejected",
  "events-subscribe-rejects-invalid-secret": "Invalid whsec_ secrets are rejected",
  "events-subscribe-result-shape": "events/subscribe returns id and refreshBefore",
  "events-subscribe-idempotent": "Re-subscribing with the same key is an update",
  "events-granted-lifetime": "refreshBefore is within the requested ttlMs",
  "events-no-expiry-only-when-requested": "refreshBefore is null only when ttlMs:null was requested",
  "events-receiver-consent": "Receiver consent precedes any delivery",
  "events-consent-failure-blocks-delivery": "A failed challenge blocks the subscription",
  "events-no-redirect-follow": "Deliveries do not follow redirects",
  "events-private-callback-rejected": "Private callback destinations are rejected by default",
  "events-delivery-signature": "Deliveries are signed per Standard Webhooks",
  "events-webhook-id-equals-event-id": "webhook-id equals eventId for events",
  "events-subscription-id-header": "X-MCP-Subscription-Id matches the subscription id",
  "events-delivery-content-type": "Deliveries are application/json",
  "events-delivery-body-size": "Delivery bodies are at most 256 KiB",
  "events-unsubscribe-twice": "A second unsubscribe is {} or NotFound",
  "events-push-heartbeat": "Push streams send heartbeats (30 s cadence)",
  "chatgpt-readiness-webhook-listed": "At least one event lists webhook delivery",
  "chatgpt-readiness-protocol-version": "The connection negotiated 2026-07-28",
};

function strengthFor(id: EventsCheckId, profile: EventsProfileId): EventsCheckStrength {
  switch (id) {
    case "events-granted-lifetime":
    case "events-private-callback-rejected":
      return "SHOULD";
    case "events-delivery-body-size":
      return getEventsProfile(profile).maxBodyBytes.value.strength;
    default:
      return "MUST";
  }
}

const DEFAULT_CHECKS = EVENTS_CHECK_IDS.filter((id) => id !== "events-push-heartbeat");

function requiredMissing(
  descriptor: EventDescriptorWire,
  args: Record<string, unknown> | undefined
): string[] {
  const required = (descriptor.inputSchema as { required?: unknown } | undefined)?.required;
  if (!Array.isArray(required)) return [];
  return required.filter(
    (key): key is string => typeof key === "string" && (args === undefined || !(key in args))
  );
}

function errorCode(error: unknown): number | undefined {
  const code = (error as { code?: unknown })?.code;
  return typeof code === "number" ? code : undefined;
}

export async function runEventsConformance(
  config: EventsConformanceConfig
): Promise<EventsConformanceResult> {
  const started = Date.now();
  const selected = new Set(config.checkIds ?? DEFAULT_CHECKS);
  const results = new Map<EventsCheckId, EventsCheckResult>();
  const { manager, serverId, profile, receiver } = config;
  const overrides: EventsConformanceResult["overrides"] =
    receiver?.insecure ? ["insecure-local-receiver"] : [];

  const record = (
    id: EventsCheckId,
    status: EventsCheckResult["status"] | "violation",
    message: string,
    extras: { skipReason?: EventsCheckResult["skipReason"]; details?: Record<string, unknown>; startedAt?: number } = {}
  ) => {
    if (!selected.has(id)) return;
    const strength = strengthFor(id, profile);
    // A violation fails a MUST and warns a SHOULD.
    const resolved =
      status === "violation" ? (strength === "MUST" ? "failed" : "warned") : status;
    results.set(id, {
      id,
      title: TITLES[id],
      strength,
      status: resolved,
      message,
      ...(extras.skipReason ? { skipReason: extras.skipReason } : {}),
      ...(extras.details ? { details: extras.details } : {}),
      durationMs: extras.startedAt ? Date.now() - extras.startedAt : 0,
    });
  };
  const skipAll = (ids: EventsCheckId[], message: string, reason: "not-applicable" | "could-not-run") => {
    for (const id of ids) {
      if (!results.has(id)) record(id, "skipped", message, { skipReason: reason });
    }
  };

  // ---- capability + discovery -------------------------------------------------
  const support = await manager.ensureEventsSupport(serverId);
  const protocolVersion = manager.getNegotiatedProtocolVersion(serverId);
  record(
    "events-capability-declared",
    support.declared ? "passed" : "violation",
    support.declared
      ? `capabilities.events declared (${support.source})`
      : support.handshakeObserved
        ? "the handshake carried no top-level capabilities.events"
        : "the handshake was not observed"
  );

  if (profile === CHATGPT_PROFILE_ID) {
    record(
      "chatgpt-readiness-protocol-version",
      protocolVersion === "2026-07-28" ? "passed" : "violation",
      `negotiated ${protocolVersion ?? "unknown"}; ChatGPT requires 2026-07-28`
    );
  } else {
    skipAll(["chatgpt-readiness-protocol-version", "chatgpt-readiness-webhook-listed"], "ChatGPT profile only", "not-applicable");
  }

  if (!support.declared) {
    skipAll([...selected], "the server does not declare events", "not-applicable");
    return finish();
  }

  const descriptors: EventDescriptorWire[] = [];
  const listStarted = Date.now();
  try {
    let cursor: string | undefined;
    for (let page = 0; page < 20; page += 1) {
      const result = await manager.listServerEvents(serverId, cursor !== undefined ? { cursor } : undefined);
      descriptors.push(...result.events);
      if (result.nextCursor === undefined || result.nextCursor === cursor) break;
      cursor = result.nextCursor;
    }
    const unknownModes = descriptors.flatMap((d) =>
      d.delivery.filter((mode) => !(EVENT_DELIVERY_MODES as readonly string[]).includes(mode))
    );
    record(
      "events-list-shape",
      "passed",
      `${descriptors.length} event type(s)` +
        (unknownModes.length ? `; unrecognized delivery modes: ${unknownModes.join(", ")}` : ""),
      { startedAt: listStarted }
    );
  } catch (error) {
    record("events-list-shape", "violation", error instanceof Error ? error.message : String(error), {
      startedAt: listStarted,
    });
  }

  if (profile === CHATGPT_PROFILE_ID) {
    const webhookTypes = descriptors.filter((d) => d.delivery.includes("webhook"));
    record(
      "chatgpt-readiness-webhook-listed",
      webhookTypes.length > 0 ? "passed" : "violation",
      webhookTypes.length > 0
        ? `${webhookTypes.length} event type(s) list webhook`
        : "no event type lists webhook delivery, the only mode ChatGPT uses"
    );
  }

  const usable = (mode: string) =>
    descriptors.find((d) => d.delivery.includes(mode) && requiredMissing(d, config.eventArguments?.[d.name]).length === 0);
  const argsFor = (d: EventDescriptorWire) => config.eventArguments?.[d.name] ?? {};
  const missingNote = (mode: string) => {
    const candidate = descriptors.find((d) => d.delivery.includes(mode));
    if (!candidate) return { reason: "not-applicable" as const, message: `no event type offers ${mode}` };
    return {
      reason: "could-not-run" as const,
      message: `supply eventArguments for "${candidate.name}" (required: ${requiredMissing(candidate, config.eventArguments?.[candidate.name]).join(", ")})`,
    };
  };

  // ---- poll ------------------------------------------------------------------
  const pollType = usable("poll");
  if (pollType) {
    const startedAt = Date.now();
    try {
      const result = await manager.pollServerEvents(serverId, {
        name: pollType.name,
        arguments: argsFor(pollType),
        cursor: null,
      });
      record(
        "events-poll-null-cursor",
        result.events.length === 0 ? "passed" : "violation",
        result.events.length === 0
          ? "no history replayed for cursor:null"
          : `cursor:null replayed ${result.events.length} historical event(s)`,
        { startedAt }
      );
    } catch (error) {
      record("events-poll-null-cursor", "violation", String((error as Error).message ?? error), { startedAt });
    }
  } else {
    const note = missingNote("poll");
    record("events-poll-null-cursor", "skipped", note.message, { skipReason: note.reason });
  }

  // ---- webhook ---------------------------------------------------------------
  const webhookChecks: EventsCheckId[] = [
    "events-subscribe-rejects-http-callback",
    "events-subscribe-rejects-invalid-secret",
    "events-subscribe-result-shape",
    "events-subscribe-idempotent",
    "events-granted-lifetime",
    "events-no-expiry-only-when-requested",
    "events-receiver-consent",
    "events-consent-failure-blocks-delivery",
    "events-no-redirect-follow",
    "events-private-callback-rejected",
    "events-delivery-signature",
    "events-webhook-id-equals-event-id",
    "events-subscription-id-header",
    "events-delivery-content-type",
    "events-delivery-body-size",
    "events-unsubscribe-twice",
  ];
  const webhookType = usable("webhook");
  if (!webhookType) {
    const note = missingNote("webhook");
    skipAll(webhookChecks, note.message, note.reason);
  } else if (!receiver) {
    skipAll(webhookChecks, "no webhook receiver was provided for this run", "could-not-run");
  } else {
    await runWebhookChecks(webhookType, argsFor(webhookType), receiver);
  }

  // ---- push ------------------------------------------------------------------
  if (selected.has("events-push-heartbeat")) {
    const pushType = usable("push");
    if (!pushType) {
      const note = missingNote("push");
      record("events-push-heartbeat", "skipped", note.message, { skipReason: note.reason });
    } else {
      await runHeartbeatCheck(pushType, argsFor(pushType));
    }
  }

  return finish();

  // =========================================================================

  async function subscribe(
    descriptor: EventDescriptorWire,
    args: Record<string, unknown>,
    url: string,
    secret: string,
    ttlMs: number | null | undefined
  ): Promise<EventsSubscribeResultWire> {
    return manager.subscribeServerEvents(serverId, {
      name: descriptor.name,
      arguments: args,
      delivery: { url, secret },
      cursor: null,
      ...(ttlMs !== undefined ? { ttlMs } : {}),
    });
  }

  async function allocate(): Promise<{ slotId: string; callbackUrl: string; secret: string }> {
    return receiver!.inbox.allocateSlot({
      logicalSubscriptionId: `conformance_${Date.now()}`,
      projectId: "conformance",
      environmentId: null,
      bindingKey: "conformance",
      dispatch: false,
    });
  }

  async function quietUnsubscribe(descriptor: EventDescriptorWire, args: Record<string, unknown>, url: string) {
    try {
      await manager.unsubscribeServerEvents(serverId, { name: descriptor.name, arguments: args, delivery: { url } });
    } catch {
      // Best-effort cleanup.
    }
  }

  async function runWebhookChecks(
    descriptor: EventDescriptorWire,
    args: Record<string, unknown>,
    rx: EventsConformanceReceiver
  ): Promise<void> {
    // (a) http callback rejected with InvalidParams.
    {
      const startedAt = Date.now();
      try {
        await subscribe(descriptor, args, "http://callback.invalid/hooks", generateWebhookSecret(), 60_000);
        record("events-subscribe-rejects-http-callback", "violation", "a plain-http callback URL was accepted", { startedAt });
        await quietUnsubscribe(descriptor, args, "http://callback.invalid/hooks");
      } catch (error) {
        const code = errorCode(error);
        record(
          "events-subscribe-rejects-http-callback",
          code === -32602 ? "passed" : "violation",
          code === -32602 ? "rejected with -32602" : `rejected, but with ${code ?? "no code"} instead of -32602`,
          { startedAt }
        );
      }
    }
    // (b) invalid secret rejected.
    {
      const startedAt = Date.now();
      const slot = await allocate();
      const badSecret = `whsec_${btoa("12345678")}`;
      try {
        await subscribe(descriptor, args, slot.callbackUrl, badSecret, 60_000);
        record("events-subscribe-rejects-invalid-secret", "violation", "an 8-byte secret was accepted", { startedAt });
        await quietUnsubscribe(descriptor, args, slot.callbackUrl);
      } catch (error) {
        const code = errorCode(error);
        record(
          "events-subscribe-rejects-invalid-secret",
          code === -32602 ? "passed" : "violation",
          code === -32602 ? "rejected with -32602" : `rejected with ${code ?? "no code"} instead of -32602`,
          { startedAt }
        );
      }
    }

    // (c–g) the main subscription.
    const main = await allocate();
    const requestedTtl = 60 * 60 * 1000;
    let first: EventsSubscribeResultWire | undefined;
    const subscribedAt = Date.now();
    try {
      first = await subscribe(descriptor, args, main.callbackUrl, main.secret, requestedTtl);
      await rx.inbox.reconcile(main.slotId, first.id);
      record("events-subscribe-result-shape", "passed", `id ${first.id}, refreshBefore ${String(first.refreshBefore)}`, {
        startedAt: subscribedAt,
      });
    } catch (error) {
      const classified = classifyEventsRpcError("events/subscribe", error);
      record("events-subscribe-result-shape", "violation", `subscribe failed: ${(error as Error).message}`, {
        startedAt: subscribedAt,
        ...(classified ? { details: { kind: classified.kind, data: classified.data } } : {}),
      });
      skipAll(webhookChecks, "the main subscription could not be created", "could-not-run");
      return;
    }

    const mainObservations = () => rx.observations.filter((o) => o.slotId === main.slotId);
    const verification = mainObservations().find((o) => o.bodyKind === "verification");
    const firstEventIndex = mainObservations().findIndex((o) => o.bodyKind === "event");
    const verificationIndex = mainObservations().findIndex((o) => o.bodyKind === "verification");
    if (!verification) {
      record(
        "events-receiver-consent",
        "skipped",
        "no verification challenge was sent; the server may use an allowlist, out-of-band verification or the well-known document, which this run cannot observe",
        { skipReason: "not-applicable" }
      );
    } else {
      const ok = verification.status === 200 && (firstEventIndex === -1 || verificationIndex < firstEventIndex);
      record(
        "events-receiver-consent",
        ok ? "passed" : "violation",
        ok ? "a signed challenge preceded every delivery" : "an event was delivered before consent",
      );
    }

    if (first.refreshBefore === null) {
      record("events-no-expiry-only-when-requested", "violation", "refreshBefore:null granted for a finite ttlMs");
      record("events-granted-lifetime", "skipped", "no finite grant to compare", { skipReason: "not-applicable" });
    } else {
      record("events-no-expiry-only-when-requested", "passed", "finite grant for a finite request");
      const grantedMs = Date.parse(first.refreshBefore!) - subscribedAt;
      record(
        "events-granted-lifetime",
        grantedMs <= requestedTtl + 60_000 ? "passed" : "violation",
        `requested ${requestedTtl} ms, granted ~${grantedMs} ms` +
          (grantedMs > requestedTtl + 60_000 ? " (longer than requested; only a clamp UP to a server minimum is sanctioned)" : ""),
        { details: { requestedTtlMs: requestedTtl, grantedMs } }
      );
    }

    try {
      const second = await subscribe(descriptor, args, main.callbackUrl, main.secret, requestedTtl);
      record(
        "events-subscribe-idempotent",
        second.id === first.id ? "passed" : "violation",
        second.id === first.id ? "same id on re-subscribe" : `re-subscribe returned ${second.id}, first was ${first.id}`
      );
    } catch (error) {
      record("events-subscribe-idempotent", "violation", `re-subscribe failed: ${(error as Error).message}`);
    }

    // Deliveries.
    const deliveryChecks: EventsCheckId[] = [
      "events-delivery-signature",
      "events-webhook-id-equals-event-id",
      "events-subscription-id-header",
      "events-delivery-content-type",
      "events-delivery-body-size",
    ];
    if (!config.triggerEvent) {
      skipAll(deliveryChecks, "provide triggerEvent to cause a delivery", "could-not-run");
    } else {
      const rejectionsBefore = rx.inbox.rejections.length;
      await config.triggerEvent(descriptor.name, args);
      const deadline = Date.now() + (config.waitForEventMs ?? 5_000);
      let delivery = mainObservations().find((o) => o.bodyKind === "event");
      while (!delivery && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 50));
        delivery = mainObservations().find((o) => o.bodyKind === "event");
      }
      if (!delivery) {
        skipAll(deliveryChecks, "no event delivery arrived in time", "could-not-run");
      } else {
        const badSignature = rx.inbox.rejections
          .slice(rejectionsBefore)
          .some((r) => r.slotId === main.slotId && (r.reason === "bad_signature" || r.reason === "stale_timestamp"));
        record(
          "events-delivery-signature",
          delivery.status === 200 && !badSignature ? "passed" : "violation",
          delivery.status === 200 ? "signature verified over the raw body" : `receiver answered ${delivery.status}`
        );
        record(
          "events-webhook-id-equals-event-id",
          delivery.webhookId === delivery.eventId ? "passed" : "violation",
          `webhook-id ${delivery.webhookId ?? "(missing)"}, eventId ${delivery.eventId ?? "(missing)"}`
        );
        record(
          "events-subscription-id-header",
          delivery.subscriptionIdHeader === first.id ? "passed" : "violation",
          `X-MCP-Subscription-Id ${delivery.subscriptionIdHeader ?? "(missing)"}, subscription ${first.id}`
        );
        record(
          "events-delivery-content-type",
          (delivery.contentType ?? "").toLowerCase().startsWith("application/json") ? "passed" : "violation",
          `content-type ${delivery.contentType ?? "(missing)"}`
        );
        record(
          "events-delivery-body-size",
          delivery.bodyBytes <= 262_144 ? "passed" : "violation",
          `${delivery.bodyBytes} bytes`
        );
      }
    }

    // Unsubscribe twice.
    try {
      const firstOutcome = await manager.unsubscribeServerEvents(serverId, {
        name: descriptor.name,
        arguments: args,
        delivery: { url: main.callbackUrl },
      });
      const secondOutcome = await manager.unsubscribeServerEvents(serverId, {
        name: descriptor.name,
        arguments: args,
        delivery: { url: main.callbackUrl },
      });
      record("events-unsubscribe-twice", "passed", `first ${firstOutcome}, second ${secondOutcome}`);
    } catch (error) {
      record("events-unsubscribe-twice", "violation", `unsubscribe failed: ${(error as Error).message}`);
    }

    // Consent failure blocks the subscription.
    {
      const refuse = await allocate();
      rx.refuseChallenge(refuse.slotId);
      try {
        await subscribe(descriptor, args, refuse.callbackUrl, refuse.secret, 60_000);
        const challenged = rx.observations.some((o) => o.slotId === refuse.slotId && o.bodyKind === "verification");
        record(
          "events-consent-failure-blocks-delivery",
          challenged ? "violation" : "skipped",
          challenged
            ? "the subscription was accepted after the receiver refused the challenge"
            : "no challenge was sent (consent by another method)",
          challenged ? {} : { skipReason: "not-applicable" }
        );
        await quietUnsubscribe(descriptor, args, refuse.callbackUrl);
      } catch (error) {
        const classified = classifyEventsRpcError("events/subscribe", error);
        record(
          "events-consent-failure-blocks-delivery",
          classified?.kind === "CallbackEndpointError" ? "passed" : "violation",
          classified?.kind === "CallbackEndpointError"
            ? `refused with -32015 (${String((classified.data as { reason?: unknown } | undefined)?.reason)})`
            : `refused, but with ${errorCode(error) ?? "no code"} instead of -32015`
        );
      }
    }

    // Redirects are never followed.
    {
      const trap = await allocate();
      rx.redirect(trap.slotId);
      try {
        await subscribe(descriptor, args, trap.callbackUrl, trap.secret, 60_000);
        await quietUnsubscribe(descriptor, args, trap.callbackUrl);
      } catch {
        // Expected: the challenge got a 3xx.
      }
      const followed = rx.redirectHits.some((path) => path.endsWith(trap.slotId));
      record(
        "events-no-redirect-follow",
        followed ? "violation" : "passed",
        followed ? "the server followed a redirect from the callback URL" : "the redirect was not followed"
      );
    }

    // Private destinations (SHOULD).
    {
      const privateUrl = "https://10.255.255.1/i/private/s/private";
      try {
        await subscribe(descriptor, args, privateUrl, generateWebhookSecret(), 60_000);
        record("events-private-callback-rejected", "violation", "a private (10.0.0.0/8) callback was accepted");
        await quietUnsubscribe(descriptor, args, privateUrl);
      } catch (error) {
        record("events-private-callback-rejected", "passed", `rejected (${errorCode(error) ?? "error"})`);
      }
    }
  }

  async function runHeartbeatCheck(descriptor: EventDescriptorWire, args: Record<string, unknown>) {
    const startedAt = Date.now();
    const controller = new AbortController();
    let requestId: string | number | undefined;
    const heartbeats: number[] = [];
    const handler = (notification: { params?: Record<string, unknown> }) => {
      const meta = notification.params?._meta as Record<string, unknown> | undefined;
      if (requestId !== undefined && meta?.[EVENTS_SUBSCRIPTION_ID_META_KEY] === requestId) {
        heartbeats.push(Date.now());
      }
    };
    manager.addNotificationHandler(serverId, "notifications/events/heartbeat", handler as never);
    const waitMs = config.pushHeartbeatWaitMs ?? 65_000;
    const stream = manager
      .openEventsStream(
        serverId,
        { name: descriptor.name, arguments: args, cursor: null },
        {
          signal: controller.signal,
          timeout: waitMs + 30_000,
          onRequestId: (id) => {
            requestId = id;
          },
          onRequestStreamEnd: () => {},
        }
      )
      .catch(() => undefined);
    const deadline = Date.now() + waitMs;
    while (heartbeats.length < 2 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    controller.abort();
    await stream;
    manager.removeNotificationHandler(serverId, "notifications/events/heartbeat", handler as never);
    if (heartbeats.length === 0) {
      record("events-push-heartbeat", "violation", `no heartbeat within ${waitMs} ms`, { startedAt });
      return;
    }
    const firstGap = heartbeats[0]! - startedAt;
    const cadenceOk = firstGap <= 31_000 && (heartbeats.length < 2 || heartbeats[1]! - heartbeats[0]! <= 31_000);
    // The heartbeat itself is a MUST; the 30 s cadence is a SHOULD.
    results.set("events-push-heartbeat", {
      id: "events-push-heartbeat",
      title: TITLES["events-push-heartbeat"],
      strength: "MUST",
      status: cadenceOk ? "passed" : "warned",
      message: cadenceOk
        ? `heartbeats observed (${heartbeats.length})`
        : "heartbeats observed, but slower than the 30 s SHOULD",
      durationMs: Date.now() - startedAt,
    });
  }

  function finish(): EventsConformanceResult {
    const checks = EVENTS_CHECK_IDS.filter((id) => selected.has(id)).map(
      (id) =>
        results.get(id) ?? {
          id,
          title: TITLES[id],
          strength: strengthFor(id, profile),
          status: "skipped" as const,
          skipReason: "could-not-run" as const,
          message: "not reached",
          durationMs: 0,
        }
    );
    const summary = { passed: 0, failed: 0, warned: 0, skipped: 0 };
    for (const check of checks) summary[check.status] += 1;
    const unrun = checks.some((c) => c.status === "skipped" && c.skipReason === "could-not-run");
    const outcome =
      summary.failed > 0 ? "failed" : unrun || overrides.length > 0 ? "incomplete" : "passed";
    return {
      profile,
      ...(protocolVersion !== undefined ? { protocolVersion } : {}),
      outcome,
      passed: outcome === "passed",
      overrides,
      checks,
      summary,
      target: serverId,
      durationMs: Date.now() - started,
    };
  }
}
