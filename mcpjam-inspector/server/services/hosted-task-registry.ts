/**
 * Best-effort recovery index for hosted task handles.
 *
 * A task created during a hosted turn lives on the MCP server. The browser
 * tracker is the user's primary way back to it, but it is `localStorage`: a
 * different device, a cleared profile or a 50-entry eviction loses the handle
 * while the task keeps running. This writes a row the Tasks view can recover
 * identities from.
 *
 * ## It is an index, never the source of truth
 *
 * Registered on the task-created sink with `bestEffort: true`, so nothing here
 * can fail a tool call. The task exists on the server whether or not the write
 * lands; telling the user their call failed because a recovery row didn't
 * would be strictly wrong.
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

import {
  getInternalBackendConfig,
  isEntityNotFound,
} from "./internal-backend.js";
import { logger } from "../utils/logger.js";

const UPSERT_PATH = "/internal/v1/hosted-tasks/upsert";

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

/**
 * Records a created task, or degrades.
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
  const { convexUrl, serviceToken } = getInternalBackendConfig();

  // Explicit controller + setTimeout rather than `AbortSignal.timeout()`: the
  // latter runs on the platform clock, which fake timers cannot drive, and an
  // untestable deadline is one nobody will notice has stopped working.
  const controller = new AbortController();
  const deadline = setTimeout(
    () => controller.abort(new Error("hosted task registry deadline exceeded")),
    REGISTRY_TIMEOUT_MS
  );

  // NOT bound to the turn's abort signal. A user who hits Stop is exactly the
  // user who most needs a recovery row: the task is still running on the
  // server, and the browser is about to stop listening for it.
  try {
    const response = await fetch(`${convexUrl}${UPSERT_PATH}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-inspector-service-token": serviceToken,
        authorization: `Bearer ${options.bearer}`,
      },
      body: JSON.stringify({
        projectId: options.projectId,
        serverId: event.identity.serverId,
        wire: event.wire,
        taskId: event.identity.taskId,
        lastKnownStatus: event.status ?? "working",
        ...(event.createdAt !== undefined
          ? { createdAt: Date.parse(event.createdAt) }
          : {}),
        // No `ownerUserId`, no `authContextKey`: both are server-derived and
        // the backend rejects them outright.
      }),
      signal: controller.signal,
    });

    if (response.ok) return true;

    if (response.status === 404) {
      // The backend answers a disabled feature with the SAME 404 envelope it
      // uses for "not found", deliberately, so a caller degrades identically
      // whether the routes are off or not yet deployed. The envelope is what
      // separates that from a genuine routing miss.
      if (await isEntityNotFound(response, "Not found")) {
        // A deliberately-off feature is not an incident.
        logger.info(
          "[hosted-task-registry] registry routes are disabled or undeployed; skipping",
          { taskId: event.identity.taskId }
        );
        return false;
      }
      throw new Error(
        `Hosted task registry route not found at ${convexUrl}${UPSERT_PATH} — is the backend route deployed?`
      );
    }

    if (response.status === 401) {
      // Both credentials are required; a 401 means one of them is wrong. That
      // is a misconfiguration worth surfacing, not a routine degradation.
      logger.warn(
        "[hosted-task-registry] rejected (401) — check the service token and forwarded bearer",
        { taskId: event.identity.taskId }
      );
      return false;
    }

    logger.warn("[hosted-task-registry] upsert failed", {
      status: response.status,
      taskId: event.identity.taskId,
    });
    return false;
  } finally {
    clearTimeout(deadline);
  }
}
