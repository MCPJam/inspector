/**
 * The inspector's client for the backend's connection-request routes.
 *
 * Every call here goes to `/internal/v1/server-connections/*` with the
 * `INSPECTOR_SERVICE_TOKEN` — the same channel `identity.ts` and
 * `organizations.ts` already use. That token is the ONLY authorization: the
 * request id in each body names which row is being worked on and proves
 * nothing, because `scr_…` ids are printed in tool output and carried in
 * Discord button payloads by design.
 *
 * NOTHING FROM `fetchValidationContext` MAY BE LOGGED. Its response carries a
 * decrypted access token for a third-party server, which is the one piece of
 * this flow the security boundary says must never appear in logs, analytics, or
 * an error message. Every other call here is safe to log; that one is not, so
 * it is the only function that deliberately swallows its own response shape
 * rather than returning something a caller might stringify into a log line.
 */

import {
  getInternalBackendConfig,
  isEntityNotFound,
} from "./internal-backend.js";

const BASE_PATH = "/internal/v1/server-connections";

/** Bounds the whole exchange, including reading the body — a `fetch` that has
 * resolved has not finished, and a hung body read is a hung worker. */
const REQUEST_TIMEOUT_MS = 15_000;

export class ServerConnectionBackendError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string
  ) {
    super(message);
    this.name = "ServerConnectionBackendError";
  }

  /** A 409 means someone else holds the lease or the row moved underneath us —
   * the worker should stop, not retry, because a retry races the same way. */
  get isConflict(): boolean {
    return this.status === 409;
  }

  /** The request is gone or terminal. Stop and do not reschedule. */
  get isGone(): boolean {
    return this.status === 404 || this.status === 410;
  }
}

async function callBackend<T>(
  path: string,
  body: Record<string, unknown>
): Promise<T> {
  const { convexUrl, serviceToken } = getInternalBackendConfig();
  const url = `${convexUrl}${BASE_PATH}${path}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-inspector-service-token": serviceToken,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (response.status === 404) {
      // Distinguish "this request does not exist" from "this route is not
      // deployed". Collapsing them sends someone hunting a missing row when
      // the real answer is a stale backend or a wrong CONVEX_HTTP_URL.
      if (await isEntityNotFound(response, "not found")) {
        throw new ServerConnectionBackendError(
          "Connection request not found",
          404,
          "REQUEST_NOT_FOUND"
        );
      }
      throw new Error(
        `Server-connection route not found at ${convexUrl}${BASE_PATH}${path} — is the backend deployed?`
      );
    }

    const payload = (await response.json().catch(() => null)) as {
      ok?: boolean;
      error?: string;
      code?: string;
    } | null;

    if (!response.ok || payload?.ok !== true) {
      throw new ServerConnectionBackendError(
        payload?.error ?? `Backend call failed (${response.status})`,
        response.status,
        payload?.code
      );
    }

    return payload as T;
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      throw new ServerConnectionBackendError(
        `Backend call timed out after ${REQUEST_TIMEOUT_MS}ms`,
        504
      );
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

export interface LeaseResult {
  ok: true;
  leased: boolean;
  reason?: "not-live" | "leased" | "attempts-exhausted";
  status?: string;
  serverUrl?: string;
  displayUrl?: string;
  projectId?: string | null;
  serverId?: string | null;
  requestedName?: string | null;
  discoveredAuthMethod?: "none" | "oauth" | "unsupported" | null;
}

/**
 * Take the work lease and learn which step is outstanding.
 *
 * A refusal comes back as `leased: false` with a reason rather than as an
 * error, because "another worker got there first" is the system working, not a
 * fault worth an entry in an error log.
 */
export async function acquireLease(
  requestId: string,
  leaseId: string
): Promise<LeaseResult> {
  return await callBackend<LeaseResult>("/lease", { requestId, leaseId });
}

export async function releaseLease(
  requestId: string,
  leaseId: string
): Promise<void> {
  await callBackend("/lease/release", { requestId, leaseId });
}

export interface ReportDiscoveryInput {
  requestId: string;
  leaseId: string;
  authMethod: "none" | "oauth" | "unsupported";
  registrationMode?: string;
  authorizationServerUrl?: string;
}

export async function reportDiscovery(
  input: ReportDiscoveryInput
): Promise<{ status: string; serverId: string | null }> {
  return await callBackend("/discovery", { ...input });
}

export interface ReportValidationInput {
  requestId: string;
  leaseId: string;
  outcome: "ready" | "authentication-failed" | "retryable" | "terminal";
  errorCode?: string;
  errorMessage?: string;
}

export async function reportValidation(
  input: ReportValidationInput
): Promise<{ status: string }> {
  return await callBackend("/validation", { ...input });
}

export interface ValidationContext {
  serverUrl: string | null;
  accessToken: string | null;
  authMethod: string | null;
}

/**
 * The credential for an authenticated validation attempt.
 *
 * THE RETURN VALUE IS SECRET. Do not log it, do not attach it to an error, do
 * not put it in a span attribute. It is a bearer token for a server the user
 * connected, and the security boundary for this whole feature says it never
 * leaves the backend's encrypted store except to be used here, in memory, for
 * one `initialize` call.
 */
export async function fetchValidationContext(
  requestId: string,
  leaseId: string
): Promise<ValidationContext> {
  const result = await callBackend<{ ok: true } & ValidationContext>(
    "/validation-context",
    { requestId, leaseId }
  );
  return {
    serverUrl: result.serverUrl ?? null,
    accessToken: result.accessToken ?? null,
    authMethod: result.authMethod ?? null,
  };
}

// ── Browser channel, called by the web routes on a claimed request ─────────

export async function claimHandoff(input: {
  handoffToken: string;
  continuationToken: string;
  actorUserId?: string;
}): Promise<{ requestId: string; status: string }> {
  return await callBackend("/claim", { ...input });
}

export interface HandoffState {
  requestId: string;
  status: string;
  live: boolean;
  displayUrl: string;
  hasQuery: boolean;
  requestedName: string | null;
  discoveredAuthMethod: string | null;
  projectId: string | null;
  serverId: string | null;
  serverName: string | null;
  serverEnabled: boolean;
  isGuestOwner: boolean;
  expiresAt: string;
  errorCode: string | null;
  errorMessage: string | null;
  errorRetryable: boolean | null;
  errorCandidates: Array<{ id: string; name: string; url: string }> | null;
  projects: Array<{ id: string; name: string }>;
}

export async function fetchHandoffState(
  continuationToken: string
): Promise<HandoffState> {
  return await callBackend<{ ok: true } & HandoffState>("/state", {
    continuationToken,
  });
}

export async function selectProject(
  continuationToken: string,
  projectId: string
): Promise<{ status: string }> {
  return await callBackend("/select-project", {
    continuationToken,
    projectId,
  });
}

export async function ensureDefaultProject(
  continuationToken: string
): Promise<{ status: string; projectId: string }> {
  return await callBackend("/ensure-default-project", { continuationToken });
}

export async function cancelFromHandoff(
  continuationToken: string
): Promise<{ status: string }> {
  return await callBackend("/cancel", { continuationToken });
}
