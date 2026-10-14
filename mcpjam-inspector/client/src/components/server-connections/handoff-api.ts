/**
 * The handoff page's calls to `/api/web/server-connections/*`, and how it
 * reads one that failed. The continuation cookie travels on its own; only
 * the claim carries a bearer.
 */

const API = "/api/web/server-connections";

export interface HandoffState {
  requestId: string;
  status: string;
  live: boolean;
  displayUrl: string;
  hasQuery: boolean;
  requestedName: string | null;
  serverName: string | null;
  isGuestOwner: boolean;
  errorCode: string | null;
  errorMessage: string | null;
  errorRetryable: boolean | null;
  projects: Array<{ id: string; name: string }>;
}

/**
 * Who the visitor is, when they are signed in — for the CLAIM and nothing else.
 *
 * The backend refuses an account-owned handoff link to anyone but its owner,
 * and it can only tell who is asking from a verified bearer token. This page
 * used to send none, so the ownership check compared "nobody" against an owner
 * and refused EVERY account-owned link: create a request from the CLI, open
 * the link in the very same account, get "This authorization link belongs to a
 * different account."
 *
 * `getAccessToken` comes from `AuthKitProvider`, which `main.tsx` now mounts
 * around this page. Deliberately the SDK and not a fetch at a known URL: the
 * `/user_management` proxy is mounted only when `!HOSTED_MODE`, so a
 * hand-rolled call to it 404s in hosted and silently reproduces the same
 * refusal. Only the SDK knows which AuthKit origin this deployment uses.
 *
 * BEST EFFORT, ALWAYS. A signed-out visitor, a guest, an expired session or a
 * refresh that throws all resolve to `null`, the claim proceeds without a
 * header, and possession of the single-use token remains the capability for a
 * guest-owned request exactly as before.
 */
export async function bestEffortAccessToken(
  getAccessToken: () => Promise<string | undefined>,
): Promise<string | null> {
  try {
    const token = await getAccessToken();
    return typeof token === "string" && token ? token : null;
  } catch {
    return null;
  }
}

/**
 * A failed call, with the envelope's `details` kept.
 *
 * The page used to throw a bare `Error` carrying only the message, which is
 * enough to REPORT a failure and not enough to ACT on one. A refused claim is
 * the case that needs more: whether to offer "sign in" or "switch account"
 * lives in `details`, not in the prose.
 */
export class HandoffCallError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "HandoffCallError";
  }
}

/**
 * A failure that says nothing about the link: the request never got an
 * answer (offline, a dropped connection, an unreadable body), the server
 * failed (5xx), or it asked to be tried later (408, 429). The token may well
 * still be good, so the page keeps it and offers a retry. Any other 4xx is
 * the backend's answer about THIS link.
 */
export function isTransientCallFailure(error: unknown): boolean {
  if (!(error instanceof HandoffCallError)) return true;
  return error.status >= 500 || error.status === 408 || error.status === 429;
}

export function isUsedLinkError(error: unknown): boolean {
  return (
    error instanceof HandoffCallError &&
    typeof error.details === "object" &&
    error.details !== null &&
    (error.details as { reason?: unknown }).reason === "REQUEST_NOT_FOUND"
  );
}

export async function call<T>(
  path: string,
  body?: unknown,
  accessToken?: string | null,
): Promise<T> {
  const response = await fetch(`${API}${path}`, {
    method: body === undefined ? "GET" : "POST",
    // Same-origin is the default, but stating it makes the cookie requirement
    // legible next to the fetch that depends on it.
    credentials: "same-origin",
    ...(body === undefined
      ? {}
      : {
          headers: {
            "content-type": "application/json",
            ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}),
          },
          body: JSON.stringify(body),
        }),
  });
  const payload = (await response.json().catch(() => null)) as
    (T & { message?: string; details?: unknown }) | null;
  if (!response.ok) {
    throw new HandoffCallError(
      payload?.message ?? "Something went wrong. Please try again.",
      response.status,
      payload?.details,
    );
  }
  if (!payload) throw new Error("The server sent an unreadable response.");
  return payload;
}
