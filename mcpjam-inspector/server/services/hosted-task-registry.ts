/**
 * Best-effort recovery index for hosted task handles.
 *
 * A task created during a hosted turn lives on the MCP server. The browser
 * tracker is the user's primary way back to it, but it is `localStorage`: a
 * different device, a cleared profile or a 50-entry eviction loses the handle
 * while the task keeps running. This writes a row the Tasks view can recover
 * identities from, reads those rows back, and reports observed statuses so
 * the backend's retention clocks stay honest.
 *
 * ## It is an index, never the source of truth
 *
 * Registered on the task-created sink with `bestEffort: true`, so nothing here
 * can fail a tool call. The task exists on the server whether or not the write
 * lands; telling the user their call failed because a recovery row didn't
 * would be strictly wrong. The read side degrades the same way: a registry
 * outage means "no recovery source this tick", never a failed poll.
 *
 * ## Both credentials
 *
 * The service token proves *the inspector* is calling; the forwarded user
 * bearer proves *who* it is calling for. The backend derives `ownerUserId` and
 * `authContextKey` from that bearer and REJECTS them in the body — so this
 * module deliberately sends neither, and a future edit that adds one back gets
 * a loud 400 rather than silently writing rows under the wrong owner.
 *
 * This works identically for guests: a guest session has a real `users` row
 * with the JWT subject in `externalId`, and authorization is organization
 * membership for both kinds. There is no guest branch here or on the backend.
 */

import type { TaskCreatedEvent } from "@mcpjam/sdk";

import type { RegistryTaskEntry } from "../../shared/hosted-tasks.js";
import {
  getInternalBackendConfig,
  isEntityNotFound,
} from "./internal-backend.js";
import { logger } from "../utils/logger.js";

const UPSERT_PATH = "/internal/v1/hosted-tasks/upsert";
const LIST_PATH = "/internal/v1/hosted-tasks/list";
const REPORT_PATH = "/internal/v1/hosted-tasks/report";
const DELETE_PATH = "/internal/v1/hosted-tasks/delete";

/**
 * Deliberately under the sink's 5s `bestEffort` ceiling.
 *
 * The inner deadline has to fire first, otherwise every slow backend surfaces
 * as the sink's opaque "did not settle within 5000ms" rather than a typed
 * failure naming the route and status.
 */
const REGISTRY_TIMEOUT_MS = 3_000;

export interface HostedTaskRegistryOptions {
  /** Convex-valid bearer for the ACTING user (or guest). Not the raw header. */
  bearer: string;
  projectId: string;
}

/** Identity every read/report/delete call is scoped by. */
export interface HostedTaskRegistryScope extends HostedTaskRegistryOptions {
  serverId: string;
}

/**
 * How one registry round trip ended. Every caller maps these onto its own
 * degradation policy; none of them are exceptions:
 *
 *  - `ok` — the route ran and answered `{ ok: true, ... }`.
 *  - `disabled` — the backend's gate is off or the routes aren't deployed
 *    (the deliberate shared 404 envelope). Not an incident.
 *  - `unauthorized` — 401: the service token or the forwarded bearer was
 *    rejected. A misconfiguration worth surfacing, not a routine degradation.
 *  - `rejected` — a 400/403 verdict about THIS request; retrying is useless.
 *  - `unavailable` — a 5xx, a network failure, or the 3s deadline. Transient.
 *
 * A routing 404 without the backend's envelope still THROWS: it means
 * `CONVEX_HTTP_URL` points somewhere that never had these routes, which is a
 * deployment error, not a state this union should quietly absorb.
 */
export type RegistryOutcome<T> =
  | { kind: "ok"; value: T }
  | { kind: "disabled" }
  | { kind: "unauthorized" }
  | { kind: "rejected"; status: number }
  | { kind: "unavailable"; status?: number };

/**
 * One service-token + forwarded-bearer POST against a registry route, with the
 * shared deadline and the shared 404-envelope classification. Every exported
 * function below is a thin policy layer over this.
 */
async function registryRequest<T>(
  path: string,
  bearer: string,
  body: Record<string, unknown>
): Promise<RegistryOutcome<T>> {
  const { convexUrl, serviceToken } = getInternalBackendConfig();

  // Explicit controller + setTimeout rather than `AbortSignal.timeout()`: the
  // latter runs on the platform clock, which fake timers cannot drive, and an
  // untestable deadline is one nobody will notice has stopped working.
  const controller = new AbortController();
  const deadline = setTimeout(
    () => controller.abort(new Error("hosted task registry deadline exceeded")),
    REGISTRY_TIMEOUT_MS
  );

  // NOT bound to any request/turn abort signal. A user who hits Stop is
  // exactly the user who most needs a recovery row, and a poll response that
  // already answered deserves its observation report.
  try {
    let response: Response;
    try {
      response = await fetch(`${convexUrl}${path}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-inspector-service-token": serviceToken,
          authorization: `Bearer ${bearer}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (error) {
      // Network failure or the deadline above: the registry is unreachable,
      // which says nothing about the request.
      logger.warn("[hosted-task-registry] request failed", {
        path,
        error: error instanceof Error ? error.message : String(error),
      });
      return { kind: "unavailable" };
    }

    if (response.ok) {
      const value = (await response.json().catch(() => null)) as T | null;
      if (value === null) {
        return { kind: "unavailable", status: response.status };
      }
      return { kind: "ok", value };
    }

    if (response.status === 404) {
      // The backend answers a disabled feature with the SAME 404 envelope it
      // uses for "not found", deliberately, so a caller degrades identically
      // whether the routes are off or not yet deployed. The envelope is what
      // separates that from a genuine routing miss.
      if (await isEntityNotFound(response, "Not found")) {
        return { kind: "disabled" };
      }
      throw new Error(
        `Hosted task registry route not found at ${convexUrl}${path} — is the backend route deployed?`
      );
    }

    if (response.status === 401) {
      return { kind: "unauthorized" };
    }

    if (response.status === 400 || response.status === 403) {
      return { kind: "rejected", status: response.status };
    }

    return { kind: "unavailable", status: response.status };
  } finally {
    clearTimeout(deadline);
  }
}

/** Shared degradation logging for the two upsert entry points. */
function logUpsertOutcome(
  outcome: RegistryOutcome<unknown>,
  taskId: string
): boolean {
  switch (outcome.kind) {
    case "ok":
      return true;
    case "disabled":
      // A deliberately-off feature is not an incident.
      logger.info(
        "[hosted-task-registry] registry routes are disabled or undeployed; skipping",
        { taskId }
      );
      return false;
    case "unauthorized":
      // Both credentials are required; a 401 means one of them is wrong. That
      // is a misconfiguration worth surfacing, not a routine degradation.
      logger.warn(
        "[hosted-task-registry] rejected (401) — check the service token and forwarded bearer",
        { taskId }
      );
      return false;
    case "rejected":
    case "unavailable":
      logger.warn("[hosted-task-registry] upsert failed", {
        status: outcome.status,
        taskId,
      });
      return false;
  }
}

/**
 * Records a created task from a raw identity, for callers that hold the
 * CreateTaskResult rather than a sink `TaskCreatedEvent` (the hosted
 * `tools/execute` route). Same wire body, same degradation policy as
 * {@link recordHostedTask} — which delegates here.
 *
 * @returns `true` when a row was written, `false` for every handled
 * degradation. Never throws for a backend-side condition — only a programming
 * error (missing backend config) or a routing 404 propagates.
 */
export async function recordCreatedTask(
  scope: HostedTaskRegistryScope,
  task: {
    wire: "legacy" | "extension";
    taskId: string;
    status?: string;
    /** Epoch milliseconds, when the server reported a creation time. */
    createdAt?: number;
  }
): Promise<boolean> {
  const outcome = await registryRequest<{ ok: boolean }>(
    UPSERT_PATH,
    scope.bearer,
    {
      projectId: scope.projectId,
      serverId: scope.serverId,
      wire: task.wire,
      taskId: task.taskId,
      lastKnownStatus: task.status ?? "working",
      ...(task.createdAt !== undefined ? { createdAt: task.createdAt } : {}),
      // No `ownerUserId`, no `authContextKey`: both are server-derived and
      // the backend rejects them outright.
    }
  );
  return logUpsertOutcome(outcome, task.taskId);
}

/**
 * Records a created task from the task-created sink, or degrades.
 *
 * @returns `true` when a row was written, `false` for every handled
 * degradation. Never throws for a backend-side condition — only a programming
 * error (missing backend config) propagates, and that is caught by the sink's
 * best-effort wrapper anyway.
 */
export async function recordHostedTask(
  event: TaskCreatedEvent,
  options: HostedTaskRegistryOptions
): Promise<boolean> {
  return recordCreatedTask(
    {
      bearer: options.bearer,
      projectId: options.projectId,
      serverId: event.identity.serverId,
    },
    {
      wire: event.wire,
      taskId: event.identity.taskId,
      status: event.status,
      ...(event.createdAt !== undefined
        ? { createdAt: Date.parse(event.createdAt) }
        : {}),
    }
  );
}

/**
 * The recovery rows for `(caller, project, server)` under the caller's own
 * authorization context.
 *
 * @returns the entries, or `null` when there is NO recovery source this tick
 * (disabled, unauthorized, rejected, or unavailable). `null` and `[]` are
 * deliberately distinct: `[]` is a verified "this owner has no rows", which a
 * caller may treat as authoritative, while `null` must leave whatever the
 * caller already knows untouched.
 */
export async function listRegistryTasks(
  scope: HostedTaskRegistryScope,
  options: { nonTerminalOnly?: boolean; limit?: number } = {}
): Promise<RegistryTaskEntry[] | null> {
  const outcome = await registryRequest<{
    ok: boolean;
    tasks?: RegistryTaskEntry[];
  }>(LIST_PATH, scope.bearer, {
    projectId: scope.projectId,
    serverId: scope.serverId,
    ...(options.nonTerminalOnly === true ? { nonTerminalOnly: true } : {}),
    ...(typeof options.limit === "number" ? { limit: options.limit } : {}),
  });
  switch (outcome.kind) {
    case "ok":
      return Array.isArray(outcome.value.tasks) ? outcome.value.tasks : null;
    case "disabled":
      logger.info(
        "[hosted-task-registry] registry routes are disabled or undeployed; no recovery source",
        { serverId: scope.serverId }
      );
      return null;
    case "unauthorized":
      logger.warn(
        "[hosted-task-registry] list rejected (401) — check the service token and forwarded bearer",
        { serverId: scope.serverId }
      );
      return null;
    case "rejected":
    case "unavailable":
      // NEVER []: an outage must not read as "verified empty" — that would
      // tell the caller to stop tracking handles that are still running.
      logger.warn("[hosted-task-registry] list failed", {
        status: outcome.status,
        serverId: scope.serverId,
      });
      return null;
  }
}

/**
 * Reports statuses a live read actually observed, so the backend can advance
 * each row's unobservability clock (`observed: true` is what does that —
 * fail-closed on the backend, so it is always sent here) and prune terminal
 * rows on schedule.
 *
 * Fire-and-forget safe: never throws, one warn per failed batch, and an empty
 * batch sends no request at all. A degraded `{ ok: true, degraded: true }`
 * reply is SUCCESS — the backend chose that envelope precisely so reporting
 * can never fail the poll that produced the observations.
 */
export async function reportTaskStatuses(
  scope: HostedTaskRegistryScope,
  updates: readonly {
    wire: "legacy" | "extension";
    taskId: string;
    status: string;
  }[]
): Promise<void> {
  if (updates.length === 0) return;
  try {
    const outcome = await registryRequest<{ ok: boolean }>(
      REPORT_PATH,
      scope.bearer,
      {
        projectId: scope.projectId,
        serverId: scope.serverId,
        updates: updates.map((update) => ({
          wire: update.wire,
          taskId: update.taskId,
          lastKnownStatus: update.status,
          // Always true from this caller: every update here came from a live
          // read that actually answered for the handle. The backend ignores
          // anything but an explicit `true`.
          observed: true,
        })),
      }
    );
    if (outcome.kind === "disabled") return;
    if (outcome.kind !== "ok") {
      logger.warn("[hosted-task-registry] status report failed", {
        kind: outcome.kind,
        serverId: scope.serverId,
        updates: updates.length,
      });
    }
  } catch (error) {
    // Includes the routing-404 throw: a status report is bookkeeping and must
    // never surface through a poll, so even the deployment error is one warn.
    logger.warn("[hosted-task-registry] status report failed", {
      serverId: scope.serverId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Removes one recovery row for its owner — the separately authorized GLOBAL
 * operation, distinct from a local dismissal (a view preference on one
 * browser).
 *
 * NO production caller yet, deliberately: v1 dismissal stays local, and
 * "remove everywhere" is deferred per the master plan. Implemented and tested
 * now so the wire contract ships alongside the routes it talks to.
 *
 * @returns `true` only when the backend confirmed the removal. A 503 is
 * `false`: the backend refuses to fake a degraded success here because the
 * row would survive and the handle would reappear on the next recovery read.
 */
export async function deleteRegistryTask(
  scope: HostedTaskRegistryScope,
  task: { wire: "legacy" | "extension"; taskId: string }
): Promise<boolean> {
  const outcome = await registryRequest<{ ok: boolean }>(
    DELETE_PATH,
    scope.bearer,
    {
      projectId: scope.projectId,
      serverId: scope.serverId,
      wire: task.wire,
      taskId: task.taskId,
    }
  );
  switch (outcome.kind) {
    case "ok":
      return true;
    case "disabled":
      logger.info(
        "[hosted-task-registry] registry routes are disabled or undeployed; nothing to delete",
        { taskId: task.taskId }
      );
      return false;
    case "unauthorized":
      logger.warn(
        "[hosted-task-registry] delete rejected (401) — check the service token and forwarded bearer",
        { taskId: task.taskId }
      );
      return false;
    case "rejected":
    case "unavailable":
      logger.warn("[hosted-task-registry] delete failed", {
        status: outcome.status,
        taskId: task.taskId,
      });
      return false;
  }
}
