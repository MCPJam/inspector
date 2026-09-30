/**
 * The hosted MCP Events subscription keeper (contracts C4, C9).
 *
 * A claim-and-commit loop over the Convex registry: every few seconds it
 * leases the due HOSTED subscriptions (`subscriptions/claim`), performs ONE
 * coordinator step for each, and commits the step's patch with
 * compare-and-set on the row's lease token and generation
 * (`subscriptions/commit`). A user edit that bumped the generation since the
 * claim — or another replica holding the lease — makes the commit a 409, and
 * the step's work is simply dropped: the next claim re-reads the row.
 *
 * Every lifecycle rule (subscribe, refresh, rotate, poll, unsubscribe, gap,
 * terminate) lives in the SDK's `EventsCoordinator`; this file only supplies
 * its ports:
 *
 *   - `rpc`   — an `EventsRpcPort` over a manager authorized with the
 *               subscription OWNER'S delegated bearer (`createAuthorizedManager`,
 *               which re-authorizes the server for that user). Connected
 *               lazily inside each port call, so a connection or auth failure
 *               is classified by the coordinator (auth ⇒ `paused_auth`)
 *               instead of escaping the step. Disconnected in `finally`.
 *   - `inbox` — the hosted inbox client for the row's `inboxId`, ensuring the
 *               project's inbox first when the row has none yet.
 *
 * Secrets (slot secrets, bearers) never reach a log line: failures are logged
 * by kind and the subscription's logical id only.
 *
 * Env-gated: `EVENTS_KEEPER_ENABLED === "1"`, started from `server/index.ts`.
 */

import {
  EventsCoordinator,
  classifyStepFailure,
  computeBackoffMs,
  type EventsCoordinatorOptions,
  type EventsRpcPort,
  type InboxPort,
  type StepOutcome,
  type SubscriptionRecord,
} from "@mcpjam/sdk/events";
import { WEB_CALL_TIMEOUT_MS } from "../../config.js";
import { logger } from "../../utils/logger.js";
import {
  EventsBackendClient,
  StaleLeaseError,
  isEventsBackendConfigured,
  type EventSubscriptionRow,
  type SubscriptionClaimItem,
  type SubscriptionCommitRequest,
} from "./backend-client.js";
import { defaultEventsHolder, isEventsKeeperEnabled } from "./config.js";
import { HttpInboxClient } from "./inbox-client.js";

const POLL_INTERVAL_MS = 5_000;
const POLL_JITTER_MS = 1_000;
const ERROR_BACKOFF_MS = 30_000;
const CLAIM_LIMIT = 10;
const LEASE_MS = 60_000;
const STEP_CONCURRENCY = 4;
const MAX_FAILURE_BACKOFF_MS = 30 * 60 * 1000;

/**
 * Fields the backend lets a keeper UNSET (`CLEARABLE_SUBSCRIPTION_FIELDS` in
 * `convex/eventSubscriptions.ts`). `observedState`, `nextActionAt` and
 * `consecutiveFailures` are required columns and are never cleared.
 */
export const CLEARABLE_SUBSCRIPTION_FIELDS: ReadonlySet<string> = new Set([
  "refreshBefore",
  "lastCursor",
  "inboxId",
  "slotId",
  "callbackUrl",
  "serverSubscriptionId",
  "conflictingServerSubscriptionId",
  "deliveryStatus",
  "lastError",
  "settledRemovalAt",
  "removalUnsubscribedAt",
  "lastGapAt",
  "terminatedError",
  "rotation",
  "lastHealthCheckAt",
  "maxAgeMs",
  "ttlMs",
]);

// ---------------------------------------------------------------------------
// Row ↔ record mapping
// ---------------------------------------------------------------------------

const OPTIONAL_RECORD_FIELDS = [
  "refreshBefore",
  "lastCursor",
  "inboxId",
  "slotId",
  "callbackUrl",
  "serverSubscriptionId",
  "conflictingServerSubscriptionId",
  "deliveryStatus",
  "lastError",
  "removalUnsubscribedAt",
  "settledRemovalAt",
  "rotation",
  "lastHealthCheckAt",
  "lastGapAt",
  "terminatedError",
  "maxAgeMs",
  "ttlMs",
] as const;

/**
 * A C4 registry row as the coordinator sees it: `logicalId` is the record id
 * (every inbox identity is keyed on it), the binding's server is the record's
 * server, and the CLAIM's generation is the one the commit will be fenced on.
 */
export function subscriptionRecordFromRow(
  row: EventSubscriptionRow,
  generation: number = row.generation,
): SubscriptionRecord {
  const record: SubscriptionRecord = {
    id: row.logicalId,
    projectId: String(row.projectId),
    environmentId: row.environmentId ? String(row.environmentId) : null,
    bindingKey: row.bindingKey,
    serverId: row.binding.serverId,
    profile: row.profile,
    eventName: row.eventName,
    arguments:
      row.arguments && typeof row.arguments === "object"
        ? (row.arguments as Record<string, unknown>)
        : {},
    mode: row.mode,
    desiredState: row.desiredState,
    observedState: row.observedState,
    generation,
    nextActionAt: row.nextActionAt,
    consecutiveFailures: row.consecutiveFailures ?? 0,
  };
  const target = record as unknown as Record<string, unknown>;
  for (const field of OPTIONAL_RECORD_FIELDS) {
    const value = (row as Record<string, unknown>)[field];
    if (value !== undefined) target[field] = value;
  }
  return record;
}

/** The backend's `lastError` validator takes exactly these four fields. */
function sanitizeLastError(value: unknown): unknown {
  if (!value || typeof value !== "object") return value;
  const error = value as Record<string, unknown>;
  return {
    kind: String(error.kind ?? "unknown"),
    message: String(error.message ?? ""),
    at: typeof error.at === "number" ? error.at : Date.now(),
    retryable: error.retryable === true,
  };
}

/**
 * The CAS commit for one step: DEFINED patch fields are written, fields the
 * step set to `undefined` are named in `clear` (JSON cannot carry
 * `undefined`), and `nextActionAt` rides in the patch. The lease is released
 * so the row is claimable again at `nextActionAt`.
 */
export function commitRequestFromOutcome(
  item: SubscriptionClaimItem,
  outcome: Pick<StepOutcome, "patch" | "nextActionAt">,
  extraPatch: Record<string, unknown> = {},
): SubscriptionCommitRequest {
  const patch: Record<string, unknown> = {};
  const clear: string[] = [];
  for (const [key, value] of Object.entries({ ...extraPatch, ...outcome.patch })) {
    if (value === undefined) {
      if (CLEARABLE_SUBSCRIPTION_FIELDS.has(key)) clear.push(key);
      continue;
    }
    patch[key] = key === "lastError" ? sanitizeLastError(value) : value;
  }
  patch.nextActionAt = outcome.nextActionAt;
  return {
    subscriptionId: String(item.subscription._id),
    leaseToken: item.leaseToken,
    generation: item.generation,
    patch,
    ...(clear.length > 0 ? { clear } : {}),
    release: true,
  };
}

// ---------------------------------------------------------------------------
// Ports
// ---------------------------------------------------------------------------

export interface KeeperConnection {
  rpc: EventsRpcPort;
  close(): Promise<void>;
}

export interface KeeperDeps {
  backend: Pick<
    EventsBackendClient,
    "claimSubscriptions" | "commitSubscription" | "ensureInbox"
  >;
  /** The inbox client for one inbox id. Default: {@link HttpInboxClient}. */
  inboxFor?: (inboxId: string) => InboxPort;
  /** Connect the subscription's server as its owner. Default: delegated bearer. */
  connect?: (item: SubscriptionClaimItem, record: SubscriptionRecord) => Promise<KeeperConnection>;
  clock?: { now(): number };
  coordinatorOptions?: Omit<EventsCoordinatorOptions, "rpc" | "inbox" | "clock">;
}

/**
 * The production connection: the owner's delegated org JWT, then a manager
 * authorized for exactly the subscription's server (C7 "Execute tools" /
 * "Refresh": `createAuthorizedManager` re-authorizes it for that user).
 */
async function connectAsOwner(
  item: SubscriptionClaimItem,
  record: SubscriptionRecord,
): Promise<KeeperConnection> {
  const [{ getConvexBearerForDelegation }, { createAuthorizedManager }] = await Promise.all([
    import("../../utils/v1-convex-token.js"),
    import("../../routes/web/auth.js"),
  ]);
  const bearer = await getConvexBearerForDelegation(
    item.ownerExternalId,
    item.organizationId,
  );
  const { manager } = await createAuthorizedManager(
    {},
    bearer,
    record.projectId,
    [record.serverId],
    WEB_CALL_TIMEOUT_MS,
  );
  const serverId = record.serverId;
  return {
    rpc: {
      list: (params) => manager.listServerEvents(serverId, params),
      poll: (params) => manager.pollServerEvents(serverId, params),
      subscribe: (params) => manager.subscribeServerEvents(serverId, params),
      unsubscribe: (params) => manager.unsubscribeServerEvents(serverId, params),
    },
    close: () => manager.disconnectAllServers().catch(() => undefined),
  };
}

/**
 * An rpc port that connects on first use. Connecting inside the port call
 * puts a connect/auth failure inside the coordinator's own try blocks, where
 * it is classified — rather than escaping the step and being retried by lease
 * expiry forever.
 */
function lazyRpcPort(open: () => Promise<KeeperConnection>): {
  port: EventsRpcPort;
  close(): Promise<void>;
} {
  let connection: Promise<KeeperConnection> | undefined;
  const get = () => (connection ??= open());
  return {
    port: {
      list: async (params) => (await get()).rpc.list(params),
      poll: async (params) => (await get()).rpc.poll(params),
      subscribe: async (params) => (await get()).rpc.subscribe(params),
      unsubscribe: async (params) => (await get()).rpc.unsubscribe(params),
    },
    close: async () => {
      if (!connection) return;
      try {
        await (await connection).close();
      } catch {
        // A connection that never opened has nothing to close.
      }
    },
  };
}

// ---------------------------------------------------------------------------
// One claimed item
// ---------------------------------------------------------------------------

export type KeeperItemResult =
  | "committed"
  | "stale"
  | "failed";

export async function stepClaimedSubscription(
  deps: KeeperDeps,
  item: SubscriptionClaimItem,
): Promise<KeeperItemResult> {
  const clock = deps.clock ?? { now: () => Date.now() };
  const record = subscriptionRecordFromRow(item.subscription, item.generation);
  const inboxFor = deps.inboxFor ?? ((inboxId: string) => new HttpInboxClient({ inboxId }));
  const connect = deps.connect ?? connectAsOwner;
  const extraPatch: Record<string, unknown> = {};

  const rpc = lazyRpcPort(() => connect(item, record));
  let inbox: InboxPort | undefined;
  const coordinator = new EventsCoordinator({
    ...(deps.coordinatorOptions ?? {}),
    clock,
    rpc: async () => rpc.port,
    inbox: async (current) => {
      if (inbox) return inbox;
      let inboxId = current.inboxId;
      if (!inboxId) {
        inboxId = (await deps.backend.ensureInbox(current.projectId)).inboxId;
        extraPatch.inboxId = inboxId;
      }
      inbox = inboxFor(inboxId);
      return inbox;
    },
  });

  let outcome: Pick<StepOutcome, "patch" | "nextActionAt"> & {
    action?: string;
    failure?: { kind: string };
  };
  try {
    try {
      outcome = await coordinator.step(record);
    } catch (error) {
      // The coordinator classifies every MCP and inbox failure itself; what
      // escapes it is a port that failed before any call (e.g. ensuring the
      // project's inbox). Record it as a transient failure with backoff —
      // never let the lease simply expire and re-claim the row every minute.
      const now = clock.now();
      const failure = classifyStepFailure("keeper/step", error, now);
      const failures = record.consecutiveFailures + 1;
      const { authLost: _authLost, ...lastError } = failure;
      outcome = {
        patch: { lastError: { ...lastError, retryable: true }, consecutiveFailures: failures },
        nextActionAt: now + computeBackoffMs(failures, MAX_FAILURE_BACKOFF_MS),
        action: "failed",
        failure: lastError,
      };
    }
  } finally {
    await rpc.close();
  }

  if (outcome.action === "failed" && outcome.failure) {
    logger.warn("[events-keeper] step failed", {
      subscription: record.id,
      mode: record.mode,
      kind: outcome.failure.kind,
    });
  }

  try {
    await deps.backend.commitSubscription(
      commitRequestFromOutcome(item, outcome, extraPatch),
    );
    return "committed";
  } catch (error) {
    if (error instanceof StaleLeaseError) {
      // A user edit or another replica won. The step's effects are
      // idempotent upstream (subscribe/poll replay safely); the next claim
      // re-reads the row and does the right thing.
      logger.debug("[events-keeper] commit refused as stale; dropped", {
        subscription: record.id,
        reason: error.reason,
      });
      return "stale";
    }
    logger.warn("[events-keeper] commit failed", {
      subscription: record.id,
      error: error instanceof Error ? error.message : String(error),
    });
    return "failed";
  }
}

async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await fn(items[index]!);
    }
  });
  await Promise.all(workers);
  return results;
}

/** One claim-and-step pass. Never throws for a single item's failure. */
export async function runKeeperTick(
  deps: KeeperDeps,
  holder: string,
  options: { limit?: number; leaseMs?: number; concurrency?: number } = {},
): Promise<{ claimed: number; results: KeeperItemResult[] }> {
  const items = await deps.backend.claimSubscriptions({
    holder,
    limit: options.limit ?? CLAIM_LIMIT,
    leaseMs: options.leaseMs ?? LEASE_MS,
  });
  const results = await mapWithConcurrency(
    items,
    options.concurrency ?? STEP_CONCURRENCY,
    (item) => stepClaimedSubscription(deps, item),
  );
  return { claimed: items.length, results };
}

// ---------------------------------------------------------------------------
// Loop
// ---------------------------------------------------------------------------

export interface EventsKeeperHandle {
  /** Stops polling and resolves once the in-flight tick settles. */
  stop(): Promise<void>;
  /** Wake the loop now (e.g. a user just created a subscription). */
  kick(): void;
}

let activeKeeper: EventsKeeperHandle | undefined;

/** Wake the running keeper, if this replica runs one. */
export function kickEventsKeeper(): void {
  activeKeeper?.kick();
}

export function startEventsKeeper(options?: {
  claimedBy?: string;
  deps?: KeeperDeps;
  /** Test seam: skip the env gate. */
  force?: boolean;
  intervalMs?: number;
}): EventsKeeperHandle {
  if (!options?.force && !isEventsKeeperEnabled()) {
    return { stop: async () => {}, kick: () => {} };
  }
  const holder = options?.claimedBy ?? defaultEventsHolder("inspector-events-keeper");
  if (!options?.deps && !isEventsBackendConfigured()) {
    logger.warn(
      "[events-keeper] enabled but CONVEX_HTTP_URL / INSPECTOR_SERVICE_TOKEN missing; not starting",
    );
    return { stop: async () => {}, kick: () => {} };
  }
  const deps: KeeperDeps = options?.deps ?? { backend: new EventsBackendClient() };

  const abort = new AbortController();
  let wake: (() => void) | undefined;
  let kicked = false;
  const intervalMs = options?.intervalMs ?? POLL_INTERVAL_MS;

  const sleep = (ms: number) =>
    new Promise<void>((resolve) => {
      if (kicked) {
        kicked = false;
        resolve();
        return;
      }
      const timer = setTimeout(done, ms);
      function done() {
        clearTimeout(timer);
        abort.signal.removeEventListener("abort", done);
        wake = undefined;
        resolve();
      }
      wake = done;
      abort.signal.addEventListener("abort", done, { once: true });
    });

  logger.info("[events-keeper] started", { holder });
  const loop = (async () => {
    while (!abort.signal.aborted) {
      let waitMs = intervalMs + Math.floor(Math.random() * POLL_JITTER_MS);
      try {
        const { claimed } = await runKeeperTick(deps, holder);
        // A full claim means more is due: go again right away.
        if (claimed >= CLAIM_LIMIT) waitMs = 0;
      } catch (error) {
        logger.warn("[events-keeper] claim failed", {
          error: error instanceof Error ? error.message : String(error),
        });
        waitMs = ERROR_BACKOFF_MS;
      }
      if (abort.signal.aborted) break;
      await sleep(waitMs);
    }
    logger.info("[events-keeper] stopped");
  })();

  const handle: EventsKeeperHandle = {
    stop: async () => {
      abort.abort();
      await loop;
      if (activeKeeper === handle) activeKeeper = undefined;
    },
    kick: () => {
      if (wake) wake();
      else kicked = true;
    },
  };
  activeKeeper = handle;
  return handle;
}
