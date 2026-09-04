/**
 * The hosted browser's data plane, as the rail pane uses it.
 *
 * Everything here goes to `/api/web/computers/browser/*` on the inspector
 * server, which verifies a short-lived browser token and forwards to a daemon
 * inside an E2B sandbox. The pane never reaches the box itself and never sees
 * its bearer.
 *
 * The mirror of `lib/local-browser/client.ts`, which does the same for a
 * daemon running in this process. The two differ in exactly the ways the
 * engines differ — a signed token instead of device consent, a session that
 * already exists instead of a Chromium to download — and agree everywhere they
 * can, because a pane that had to branch on more than that would be two panes.
 */

export const HOSTED_BROWSER_BASE = "/api/web/computers/browser";
export const HOSTED_BROWSER_FRAMES_PATH = `${HOSTED_BROWSER_BASE}/frames`;

/** Mints a fresh ~60s browser token. */
export type MintBrowserToken = () => Promise<{
  token: string;
  expiresAt: number;
}>;

/** The daemon's handoff lease, as the panel route reports it. */
export interface HostedBrowserLease {
  state: "free" | "held" | "parked" | "unknown";
  holder?: string;
  holderKind?: "human" | "script";
  expiresAt?: number;
}

export interface HostedBrowserSession {
  bootId: string;
  contextMode: "persistent" | "ephemeral";
  lease: HostedBrowserLease;
  /**
   * Is the lease this viewer's?
   *
   * Answered by the server because the holder is a user id the client never
   * sees. Without it a pane would have to remember "I acquired it" in its own
   * state and would forget across a reload — then tell somebody who still
   * holds a parked lease that a stranger has it, with no way to hand it back.
   */
  yours: boolean;
}

/** A refusal that carries enough for a caller to tell one apart from another. */
export class HostedBrowserError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message);
    this.name = "HostedBrowserError";
  }
}

/**
 * Re-mint this long before the stated expiry.
 *
 * Enough to cover a slow round trip and a clock a second or two out, and far
 * inside the token's own minute.
 */
const RENEW_BEFORE_MS = 15_000;

/**
 * One short-lived token, minted at most once per validity window.
 *
 * Minting per call is right for the things a person does by hand — reading the
 * session, taking control — and wrong for input, which arrives twenty times a
 * second while somebody drags a scrollbar. Each mint is a Convex action round
 * trip; per batch it would put a network hop in front of every pointer move.
 *
 * Dropped outright on a 401 as well as on expiry. An expiry-based cache alone
 * is exactly what a clock disagreeing with the server's defeats — and it would
 * defeat it permanently, since nothing else would ever invalidate the token.
 */
export function createBrowserTokenCache(mint: MintBrowserToken) {
  let cached: { token: string; expiresAt: number } | null = null;
  let inFlight: Promise<string> | null = null;

  const fetchFresh = async (): Promise<string> => {
    // Shared, so a burst of input does not open several mints at once.
    inFlight ??= mint()
      .then((minted) => {
        cached = minted;
        return minted.token;
      })
      .finally(() => {
        inFlight = null;
      });
    return inFlight;
  };

  return {
    async get(): Promise<string> {
      if (cached && cached.expiresAt - Date.now() > RENEW_BEFORE_MS) {
        return cached.token;
      }
      return fetchFresh();
    },
    /** Forget the current token; the next `get()` mints a new one. */
    invalidate(): void {
      cached = null;
    },
  };
}

export type BrowserTokenCache = ReturnType<typeof createBrowserTokenCache>;

/**
 * One authorized request, retried ONCE on a 401 with a fresh token.
 *
 * The retry is not a workaround for a flaky server: a cached token expires
 * mid-session by design, and the first call to notice is the one that gets the
 * 401. Retrying it is the difference between a pane that keeps working and one
 * that reports "unauthorized" whenever a minute rolls over. Bounded at one, so
 * a token being rejected for any other reason cannot spin.
 */
async function authorized(
  tokens: BrowserTokenCache,
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  const send = async () => {
    const headers = new Headers(init.headers);
    headers.set("authorization", `Bearer ${await tokens.get()}`);
    if (init.body) headers.set("content-type", "application/json");
    return fetch(`${HOSTED_BROWSER_BASE}${path}`, { ...init, headers });
  };
  const first = await send();
  if (first.status !== 401) return first;
  tokens.invalidate();
  return send();
}

async function decode<T>(res: Response): Promise<T> {
  const body = (await res.json().catch(() => null)) as
    | (T & { error?: string; detail?: string })
    | null;
  if (!res.ok) {
    throw new HostedBrowserError(
      body?.detail ?? body?.error ?? "The browser could not be reached.",
      res.status,
      typeof body?.error === "string" ? body.error : undefined,
    );
  }
  return body as T;
}

/**
 * Where to watch, and who holds the browser.
 *
 * `ensure` ATTACHES to a browser this computer is already able to run; it
 * never reserves a machine, so opening a pane cannot provision one.
 */
export async function fetchHostedBrowserSession(
  tokens: BrowserTokenCache,
  options: { ensure?: boolean } = {},
): Promise<HostedBrowserSession> {
  const res = await authorized(
    tokens,
    `/session${options.ensure ? "?ensure=1" : ""}`,
  );
  return decode<HostedBrowserSession>(res);
}

/**
 * Take control, keep it, or hand it back.
 *
 * `acquire` can legitimately fail — somebody else has the browser — and that
 * comes back as `took: false` rather than an error, because a refusal is an
 * answer about who is driving, not a fault.
 */
export async function actOnHostedBrowserLease(
  tokens: BrowserTokenCache,
  args: { action: "acquire" | "heartbeat" | "resume"; ttlMs?: number },
  options: { keepalive?: boolean } = {},
): Promise<{ took: boolean; lease: HostedBrowserLease; yours: boolean }> {
  const res = await authorized(tokens, "/lease", {
    method: "POST",
    body: JSON.stringify(args),
    ...(options.keepalive ? { keepalive: true } : {}),
  });
  // 409 is "somebody else has it", which the route reports with the lease that
  // explains why. Anything else is a real failure.
  if (res.status === 409) {
    const body = (await res.json().catch(() => null)) as {
      lease?: HostedBrowserLease;
    } | null;
    return {
      took: false,
      lease: body?.lease ?? { state: "unknown" },
      yours: false,
    };
  }
  const body = await decode<{
    ok: boolean;
    lease: HostedBrowserLease;
    yours: boolean;
  }>(res);
  return { took: body.ok, lease: body.lease, yours: body.yours };
}

/** Forward a batch of the person's pointer and key events. */
export async function sendHostedBrowserInput(
  tokens: BrowserTokenCache,
  args: { events: unknown[]; tabId?: string },
): Promise<{ ok: true }> {
  const res = await authorized(tokens, "/input", {
    method: "POST",
    body: JSON.stringify(args),
  });
  return decode<{ ok: true }>(res);
}

/** "This pane is still open." Keeps the box from hibernating underneath it. */
export async function touchHostedBrowser(
  tokens: BrowserTokenCache,
): Promise<{ counted: boolean }> {
  const res = await authorized(tokens, "/keepalive", { method: "POST" });
  return decode<{ counted: boolean }>(res);
}

/**
 * Open the frame socket.
 *
 * The token rides `Sec-WebSocket-Protocol` because a browser cannot set a
 * header on a handshake and a query string would land in proxy access logs —
 * the same shape as the RFB stream's and the local pane's.
 *
 * NO `holder` on the query string, deliberately. The server derives it from
 * the token's claims: the daemon lets a subscriber through when
 * `holder === lease.holder`, so a holder the client could name would let
 * anyone who echoed the right id watch somebody else's held session.
 */
export function openHostedBrowserFrameStream(args: {
  token: string;
  tabId?: string;
}): { socket: WebSocket; close(): void } {
  const url = new URL(HOSTED_BROWSER_FRAMES_PATH, window.location.origin);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  if (args.tabId) url.searchParams.set("tabId", args.tabId);
  const socket = new WebSocket(url.toString(), [args.token]);
  return {
    socket,
    close: () => {
      try {
        socket.close();
      } catch {
        // Already closing.
      }
    },
  };
}
