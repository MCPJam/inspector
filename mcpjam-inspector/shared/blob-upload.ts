/**
 * Byte uploads through the backend's upload route (MJ-006).
 *
 * `POST {Convex site}/web/uploads/blob?purpose=…` takes the raw bytes, the
 * caller's Convex bearer (AuthKit or guest JWT) and a `Content-Type`, stores
 * the bytes, and answers `{ ok: true, storageId }`. The storage id then goes
 * into the same create/attach call it always did, so nothing downstream
 * changes. Each purpose is authorized, metered and capped by the backend the
 * way its create/attach step expects.
 *
 * One owner for the wire contract: the browser uses it for widget snapshots,
 * eval attachments, skill files and saved views, and the server for the
 * widget snapshots, screenshots and replays it captures on a user's behalf.
 */

/** What the bytes are for, and the scope the backend authorizes them against. */
export type BlobUploadScope =
  | {
      purpose: "widget-snapshot";
      chatSessionId: string;
      /** Hosted-scenario sessions: the redeemed scenario and its version. */
      scenarioId?: string;
      accessVersion?: number;
    }
  | { purpose: "mcp-app-view" }
  | { purpose: "eval-attachment"; suiteId: string }
  | { purpose: "skill-file"; projectId: string; skillId: string };

export type BlobUploadBody = Blob | ArrayBuffer | string;

/** The route's path on the Convex HTTP actions origin. */
export const BLOB_UPLOAD_PATH = "/web/uploads/blob";

/**
 * A refused or failed upload. `message` is ready to show: the backend's own
 * sentence when it sent one, otherwise one chosen for the status.
 */
export class BlobUploadError extends Error {
  /** HTTP status, or 0 when no answer arrived. */
  readonly status: number;
  /** The route's stable error code (`RATE_LIMITED`, `FORBIDDEN`, …), if any. */
  readonly code: string | null;
  /**
   * Why a refusal happened, when the route says more than its code — e.g.
   * `scenario_access_stale` on a 403 for a hosted-scenario upload.
   */
  readonly reason: string | null;
  /** Seconds to wait before trying again, from `Retry-After` on a 429. */
  readonly retryAfterSeconds: number | null;
  /**
   * The code and reason where a Convex error carries its payload, so the
   * shared classifiers (see `hosted-access-errors.ts`) read an upload refusal
   * the same way they read a refused mutation.
   */
  readonly data: { code: string; reason?: string } | undefined;

  constructor(
    message: string,
    status: number,
    code: string | null,
    options: { reason?: string | null; retryAfterSeconds?: number | null } = {},
  ) {
    super(message);
    this.name = "BlobUploadError";
    this.status = status;
    this.code = code;
    this.reason = options.reason ?? null;
    this.retryAfterSeconds = options.retryAfterSeconds ?? null;
    this.data = code
      ? { code, ...(this.reason ? { reason: this.reason } : {}) }
      : undefined;
  }
}

/** What the route answers, success or refusal. */
type BlobUploadAnswer = {
  ok?: unknown;
  storageId?: unknown;
  code?: unknown;
  error?: unknown;
  reason?: unknown;
};

const STATUS_MESSAGES: Record<number, string> = {
  401: "Your session has expired. Sign in again and retry.",
  403: "You do not have access to upload this file.",
  413: "The file is too large to upload.",
  415: "This type of file cannot be uploaded.",
  429: "Too many uploads right now. Wait a moment and try again.",
};
const FALLBACK_MESSAGE = "The upload failed. Try again.";

/** The route's URL for `scope`, with the purpose and its scope parameters. */
export function blobUploadUrl(siteUrl: string, scope: BlobUploadScope): string {
  const url = new URL(`${siteUrl.replace(/\/+$/, "")}${BLOB_UPLOAD_PATH}`);
  url.searchParams.set("purpose", scope.purpose);
  switch (scope.purpose) {
    case "widget-snapshot":
      url.searchParams.set("chatSessionId", scope.chatSessionId);
      if (scope.scenarioId) {
        url.searchParams.set("scenarioId", scope.scenarioId);
        if (
          typeof scope.accessVersion === "number" &&
          Number.isSafeInteger(scope.accessVersion) &&
          scope.accessVersion >= 0
        ) {
          url.searchParams.set("accessVersion", String(scope.accessVersion));
        }
      }
      break;
    case "eval-attachment":
      url.searchParams.set("suiteId", scope.suiteId);
      break;
    case "skill-file":
      url.searchParams.set("projectId", scope.projectId);
      url.searchParams.set("skillId", scope.skillId);
      break;
    case "mcp-app-view":
      break;
  }
  return url.toString();
}

function parseRetryAfterSeconds(value: string | null | undefined) {
  if (!value || !/^\d+$/.test(value.trim())) return null;
  return Number(value.trim());
}

/**
 * Upload `body` for `scope` and resolve with its storage id.
 *
 * Rejects with a {@link BlobUploadError} for a refusal or an unusable answer.
 * When `signal` aborts, the abort itself propagates, so a caller with a
 * deadline can tell a timeout from a refusal.
 */
export async function uploadBlob(args: {
  /** Convex HTTP actions origin (`*.convex.site`). */
  siteUrl: string;
  /** Convex bearer of the actor the bytes are uploaded for. */
  bearerToken: string;
  scope: BlobUploadScope;
  body: BlobUploadBody;
  contentType: string;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
}): Promise<string> {
  const fetchImpl = args.fetchImpl ?? fetch;
  let response: Response;
  try {
    response = await fetchImpl(blobUploadUrl(args.siteUrl, args.scope), {
      method: "POST",
      headers: {
        "Content-Type": args.contentType,
        Authorization: `Bearer ${args.bearerToken}`,
      },
      body: args.body,
      ...(args.signal ? { signal: args.signal } : {}),
    });
  } catch (error) {
    if (args.signal?.aborted) throw error;
    throw new BlobUploadError(
      "The upload could not reach the server. Try again.",
      0,
      null,
    );
  }

  let payload: BlobUploadAnswer | null = null;
  try {
    payload = (await response.json()) as BlobUploadAnswer | null;
  } catch (error) {
    if (args.signal?.aborted) throw error;
  }

  if (!response.ok || payload?.ok === false) {
    const status = response.status;
    throw new BlobUploadError(
      typeof payload?.error === "string" && payload.error.trim()
        ? payload.error
        : (STATUS_MESSAGES[status] ?? FALLBACK_MESSAGE),
      status,
      typeof payload?.code === "string" ? payload.code : null,
      {
        reason: typeof payload?.reason === "string" ? payload.reason : null,
        retryAfterSeconds:
          status === 429
            ? parseRetryAfterSeconds(response.headers?.get?.("retry-after"))
            : null,
      },
    );
  }
  const storageId = payload?.storageId;
  if (typeof storageId !== "string" || !storageId.trim()) {
    throw new BlobUploadError(
      "The upload did not return a storage id.",
      response.status,
      null,
    );
  }
  return storageId;
}
