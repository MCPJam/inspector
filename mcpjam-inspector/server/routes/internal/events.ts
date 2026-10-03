/**
 * MCP Events internal routes (contract C5 dispatch, C6 doorbell).
 *
 *   POST /api/internal/events/enqueue   — the inbox Worker's dispatch alarm.
 *   POST /api/internal/events/dispatch  — executor doorbell (backend → us).
 *
 * `enqueue` is authenticated by `x-events-inbox-token` against
 * `EVENTS_INBOX_DISPATCH_TOKEN` (constant time, fail closed: an unconfigured
 * token refuses every request). It is the one place an event's payload is
 * checked against the subscription's descriptor before anything runs on it:
 * an event whose `data` fails the descriptor's `payloadSchema` is answered
 * `quarantined` and NOT forwarded — no trigger ever sees it — while the rest
 * of the batch goes to the backend's single `enqueue` mutation. Results come
 * back in request order, one per delivery, exactly as the inbox expects; any
 * non-200 leaves the whole batch pending on the inbox side, which retries with
 * backoff (enqueue is idempotent on `runKey`).
 *
 * `dispatch` carries no selector at all; it only wakes this replica's
 * executor, which claims from the backend's own queue.
 *
 * Neither route logs event data, tokens, or response bodies.
 */

import { createHash, timingSafeEqual } from "node:crypto";
import { Hono } from "hono";
import { validateEventPayload } from "@mcpjam/sdk/events";
import type { Context } from "hono";
import { internalServiceAuthMiddleware } from "../../middleware/internal-service-auth.js";
import {
  EventsBackendClient,
  type EnqueueResult,
  type EventDelivery,
  type EventSubscriptionRow,
} from "../../services/events/backend-client.js";
import {
  EVENTS_INBOX_DISPATCH_TOKEN_HEADER,
  getEventsInboxDispatchToken,
} from "../../services/events/config.js";
import { kickEventsExecutor } from "../../services/events/executor-bell.js";
import { logger } from "../../utils/logger.js";

/** C5 sends ≤ 25; the backend refuses > 100. */
const MAX_DELIVERIES = 100;
/** Descriptor reads are cached briefly: one batch usually names one subscription. */
const DESCRIPTOR_TTL_MS = 30_000;
const MAX_CACHED_DESCRIPTORS = 1_000;

function tokenMatches(presented: string, configured: string): boolean {
  const left = createHash("sha256").update(presented, "utf8").digest();
  const right = createHash("sha256").update(configured, "utf8").digest();
  return timingSafeEqual(left, right);
}

export function isAuthorizedInboxDispatch(c: Context): boolean {
  const configured = getEventsInboxDispatchToken();
  if (!configured) return false;
  const presented = c.req.header(EVENTS_INBOX_DISPATCH_TOKEN_HEADER)?.trim();
  if (!presented) return false;
  return tokenMatches(presented, configured);
}

/** A row we can answer at all: it names its delivery key. */
function isKeyedRow(value: unknown): value is EventDelivery {
  return (
    !!value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    typeof (value as Record<string, unknown>).deliveryKey === "string"
  );
}

/**
 * The fields the backend's enqueue validator requires. A row missing one would
 * fail the WHOLE batch there, so it is answered `quarantined` here instead and
 * the rest of the batch still lands. Everything else — `slotId: null` on a
 * slotless append, `error` on a terminated row, `data` on a keeper report,
 * fields this inspector has never heard of — passes through untouched: the
 * backend picks the fields it knows.
 */
function hasRequiredFields(row: EventDelivery): boolean {
  return (
    typeof row.kind === "string" &&
    typeof row.logicalSubscriptionId === "string" &&
    typeof row.projectId === "string" &&
    typeof row.bindingKey === "string" &&
    typeof row.receivedAt === "number"
  );
}

type DescriptorLookup = Pick<EventSubscriptionRow, "descriptor" | "descriptorHash"> | null;

export interface InternalEventsRouterDeps {
  backend?: Pick<EventsBackendClient, "enqueue" | "getSubscription">;
  kick?: () => void;
  now?: () => number;
}

export function createInternalEventsRouter(deps: InternalEventsRouterDeps = {}): Hono {
  const router = new Hono();
  let backend = deps.backend;
  const getBackend = () => (backend ??= new EventsBackendClient());
  const kick = deps.kick ?? kickEventsExecutor;
  const now = deps.now ?? (() => Date.now());
  const descriptors = new Map<string, { at: number; value: DescriptorLookup }>();

  async function descriptorFor(logicalSubscriptionId: string): Promise<DescriptorLookup> {
    const cached = descriptors.get(logicalSubscriptionId);
    if (cached && now() - cached.at < DESCRIPTOR_TTL_MS) return cached.value;
    const row = await getBackend().getSubscription(logicalSubscriptionId);
    const value: DescriptorLookup = row
      ? {
          ...(row.descriptor ? { descriptor: row.descriptor } : {}),
          ...(row.descriptorHash ? { descriptorHash: row.descriptorHash } : {}),
        }
      : null;
    if (descriptors.size >= MAX_CACHED_DESCRIPTORS) descriptors.clear();
    descriptors.set(logicalSubscriptionId, { at: now(), value });
    return value;
  }

  router.post("/enqueue", async (c) => {
    if (!isAuthorizedInboxDispatch(c)) {
      return c.json({ error: "unauthorized" }, 401);
    }
    const body = (await c.req.json().catch(() => null)) as {
      inboxId?: unknown;
      deliveries?: unknown;
    } | null;
    if (
      !body ||
      typeof body.inboxId !== "string" ||
      !body.inboxId ||
      !Array.isArray(body.deliveries) ||
      body.deliveries.length > MAX_DELIVERIES ||
      !body.deliveries.every(isKeyedRow)
    ) {
      return c.json({ error: "invalid_request" }, 400);
    }
    const inboxId = body.inboxId;
    const deliveries = body.deliveries as EventDelivery[];

    // 1. Rows the backend would refuse outright, then payload validation
    //    against each subscription's descriptor.
    const quarantined = new Set<number>();
    deliveries.forEach((delivery, index) => {
      if (!hasRequiredFields(delivery)) quarantined.add(index);
    });
    try {
      const lookups = new Map<string, Promise<DescriptorLookup>>();
      for (const [index, delivery] of deliveries.entries()) {
        if (quarantined.has(index) || delivery.kind !== "event") continue;
        if (!lookups.has(delivery.logicalSubscriptionId)) {
          lookups.set(
            delivery.logicalSubscriptionId,
            descriptorFor(delivery.logicalSubscriptionId),
          );
        }
      }
      const resolved = new Map<string, DescriptorLookup>();
      for (const [logicalId, lookup] of lookups) resolved.set(logicalId, await lookup);
      deliveries.forEach((delivery, index) => {
        if (quarantined.has(index) || delivery.kind !== "event") return;
        const found = resolved.get(delivery.logicalSubscriptionId);
        const schema = found?.descriptor?.payloadSchema;
        if (!schema || typeof schema !== "object" || Array.isArray(schema)) return;
        let valid: boolean;
        try {
          // The SDK's dialect-aware check — the same one a canned eval event
          // is held to, so an eval and production agree on "malformed".
          valid = validateEventPayload(
            schema as Record<string, unknown>,
            delivery.data,
          ).valid;
        } catch {
          // A schema that cannot be compiled cannot vouch for any payload.
          valid = false;
        }
        if (!valid) quarantined.add(index);
      });
    } catch (error) {
      // Cannot read the descriptors ⇒ cannot vouch for the payloads. Refuse
      // the batch; the inbox keeps it pending and retries with backoff.
      logger.warn("[internal/events] descriptor read failed; batch left pending", {
        inboxId,
        error: error instanceof Error ? error.message : String(error),
      });
      return c.json({ error: "descriptor_unavailable" }, 503);
    }

    // 2. Forward everything that was not quarantined.
    const forward = deliveries
      .map((delivery, index) => ({ delivery, index }))
      .filter(({ index }) => !quarantined.has(index));
    let forwarded: EnqueueResult[] = [];
    if (forward.length > 0) {
      try {
        forwarded = (
          await getBackend().enqueue({
            inboxId,
            deliveries: forward.map(({ delivery }) => delivery),
          })
        ).results;
      } catch (error) {
        logger.warn("[internal/events] enqueue failed; batch left pending", {
          inboxId,
          count: forward.length,
          error: error instanceof Error ? error.message : String(error),
        });
        return c.json({ error: "enqueue_failed" }, 502);
      }
    }

    // 3. Merge in request order. The backend answers in the order it was
    //    given; a key lookup covers a backend that ever reorders.
    const byKey = new Map(forwarded.map((result) => [result.deliveryKey, result]));
    let cursor = 0;
    const results: EnqueueResult[] = [];
    deliveries.forEach((delivery, index) => {
      if (quarantined.has(index)) {
        results.push({ deliveryKey: delivery.deliveryKey, outcome: "quarantined", runIds: [] });
        return;
      }
      const positional = forwarded[cursor];
      cursor += 1;
      const match =
        positional && positional.deliveryKey === delivery.deliveryKey
          ? positional
          : byKey.get(delivery.deliveryKey);
      // A delivery the backend did not answer is left OUT: the inbox keeps a
      // row missing from `results` pending and resends it.
      if (match) results.push(match);
    });

    if (quarantined.size > 0) {
      logger.info("[internal/events] quarantined payloads failing the descriptor", {
        inboxId,
        count: quarantined.size,
      });
    }
    if (results.some((result) => result.outcome === "scheduled")) kick();
    return c.json({ results }, 200);
  });

  router.post("/dispatch", internalServiceAuthMiddleware(), async (c) => {
    kick();
    return c.json({ ok: true, accepted: true }, 202);
  });

  return router;
}

const internalEvents = createInternalEventsRouter();

export default internalEvents;
