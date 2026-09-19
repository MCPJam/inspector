/**
 * What the page asked the network for, and what came back.
 *
 * The daemon could already hand back a picture, a tree, the text and the
 * console, and none of those answer the question a broken page most often
 * poses: the layout is right, the list is empty, and nothing was logged. The
 * reason is almost always on the wire — a 401 on the fetch behind the list, a
 * request that never fired, a CORS preflight refused. Without this a model can
 * only re-read a page that will keep looking the same.
 *
 * A RING, LIKE THE CONSOLE, for the same reason: this is a tail somebody reads
 * after an act, not a document, and a page that loads a hundred images an
 * hour must not be able to grow it without bound.
 *
 * WHAT IS NOT KEPT is the point of the shape below. Request and response
 * bodies are never retained — a form post carries what someone typed, and a
 * response carries whatever the account can see. Headers are kept only from a
 * fixed allowlist, so `authorization`, `cookie` and `set-cookie` are not
 * dropped by a rule that has to remember them; they are absent because
 * nothing copies them in. A body is readable only LIVE, through an explicit
 * per-request read, and even then it is capped and never stored.
 */
import { redactForModel } from "./shape-redaction";

/** One request, folded together with its response as they arrive. */
export interface NetworkEntry {
  /** Stable within a boot; what a detail read names. */
  requestId: string;
  method: string;
  /** Query and fragment stripped — see `sanitizeNetworkUrl`. */
  url: string;
  /** `document`, `xhr`, `fetch`, `script`, … as the engine reports it. */
  resourceType?: string;
  status?: number;
  statusText?: string;
  mimeType?: string;
  /** Response body size in bytes, when the engine reports one. */
  bytes?: number;
  /** ms from request to response, when both were seen. */
  durationMs?: number;
  /** Set when the request failed outright: DNS, CORS, abort, offline. */
  failure?: string;
  /** ms since epoch, so a reader can tell "just now" from "before my act". */
  at: number;
  /** Response headers, allowlisted (see `RETAINED_HEADERS`). */
  headers?: Record<string, string>;
}

/**
 * Response headers worth keeping, and the only ones kept.
 *
 * An allowlist rather than a denylist. A denylist has to enumerate every
 * header that could carry a credential — `authorization`, `cookie`,
 * `set-cookie`, `x-api-key`, the next vendor's `x-…-token` — and it is wrong
 * the first time a server invents one. These are the headers that explain a
 * response, and none of them can carry a session.
 */
export const RETAINED_HEADERS: readonly string[] = [
  "content-type",
  "content-length",
  "content-encoding",
  "cache-control",
  "location",
  "date",
  "server",
  "via",
  "retry-after",
  "x-request-id",
  "x-trace-id",
  "traceparent",
];

const RETAINED = new Set(RETAINED_HEADERS);

/** Keep the headers that explain a response; drop everything else unread. */
export function retainHeaders(
  headers: Record<string, string> | undefined,
): Record<string, string> | undefined {
  if (!headers) return undefined;
  const kept: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    const lower = name.toLowerCase();
    if (!RETAINED.has(lower)) continue;
    // `location` IS A URL, and the one place a redirect puts its secrets: an
    // OAuth hop carries `?code=…&state=…`, a reset link carries its token.
    // Keeping it verbatim would have handed back exactly what stripping the
    // query off `url` exists to remove — the same value, one field over.
    kept[lower] =
      lower === "location"
        ? sanitizeNetworkUrl(String(value))
        : String(value).slice(0, 512);
  }
  return Object.keys(kept).length > 0 ? kept : undefined;
}

/**
 * A URL safe to keep, which means: without the parts people put secrets in.
 *
 * A query string carries session tokens, reset links and search terms, and a
 * fragment carries whatever a single-page app decided to put there. The path
 * is what identifies the request; the rest is dropped rather than redacted,
 * because a redaction has to know what it is looking for.
 */
export function sanitizeNetworkUrl(raw: string): string {
  try {
    const url = new URL(raw);
    if (url.protocol === "data:" || url.protocol === "blob:") {
      // A data URL IS its content, so there is no location to keep.
      return `${url.protocol}…`;
    }
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    // Not parseable as a URL — keep a bounded prefix rather than nothing, so
    // a malformed request is still identifiable.
    return raw.slice(0, 200);
  }
}

/** How many entries a tab's ring keeps. */
export const NETWORK_RING_SIZE = 200;

/** Budget for what one observation returns. */
export interface NetworkBudget {
  maxEntries: number;
}

export const DEFAULT_NETWORK_BUDGET: NetworkBudget = { maxEntries: 50 };

/**
 * The newest entries within budget, plus how many were left out.
 *
 * Newest, not oldest: a model asking what the network did is asking about the
 * act it just took, and the requests behind that are at the end.
 */
export function capNetwork(
  entries: readonly NetworkEntry[],
  budget: NetworkBudget = DEFAULT_NETWORK_BUDGET,
): { entries: NetworkEntry[]; omitted: number } {
  const kept = entries.slice(-budget.maxEntries);
  return {
    entries: kept.map((entry) => ({ ...entry })),
    omitted: Math.max(0, entries.length - kept.length),
  };
}

/**
 * A ring that folds a response onto the request it answers.
 *
 * Keyed by request id rather than appended twice, because a reader wants one
 * row per exchange — and because a redirect emits a fresh request event under
 * the same id for each hop, which two rows would report as two requests.
 */
export class NetworkRing {
  private readonly order: string[] = [];
  private readonly byId = new Map<string, NetworkEntry>();
  private total = 0;

  constructor(private readonly size: number = NETWORK_RING_SIZE) {}

  started(entry: {
    requestId: string;
    method: string;
    url: string;
    resourceType?: string;
  }): void {
    const existing = this.byId.get(entry.requestId);
    if (existing) {
      // A redirect hop: same id, new location. The row follows it rather than
      // splitting, so the entry describes where the request ENDED UP.
      existing.url = sanitizeNetworkUrl(entry.url);
      existing.method = entry.method;
      return;
    }
    const row: NetworkEntry = {
      requestId: entry.requestId,
      method: entry.method,
      url: sanitizeNetworkUrl(entry.url),
      ...(entry.resourceType ? { resourceType: entry.resourceType } : {}),
      at: Date.now(),
    };
    this.byId.set(row.requestId, row);
    this.order.push(row.requestId);
    this.total += 1;
    while (this.order.length > this.size) {
      const evicted = this.order.shift();
      if (evicted !== undefined) this.byId.delete(evicted);
    }
  }

  finished(update: {
    requestId: string;
    status?: number;
    statusText?: string;
    mimeType?: string;
    bytes?: number;
    headers?: Record<string, string>;
    failure?: string;
  }): void {
    const row = this.byId.get(update.requestId);
    // A response to a request the ring has already evicted is dropped rather
    // than resurrected: a row with a status and no method describes nothing.
    if (!row) return;
    if (update.status !== undefined) row.status = update.status;
    if (update.statusText) row.statusText = update.statusText;
    if (update.mimeType) row.mimeType = update.mimeType;
    if (update.bytes !== undefined) row.bytes = update.bytes;
    // Scrubbed on insert so no reader of the ring sees the raw value; failure
    // messages often quote the full URL with its query string.
    if (update.failure) row.failure = redactForModel(update.failure);
    const headers = retainHeaders(update.headers);
    if (headers) row.headers = headers;
    row.durationMs = Math.max(0, Date.now() - row.at);
  }

  entries(): readonly NetworkEntry[] {
    return this.order
      .map((id) => this.byId.get(id))
      .filter((row): row is NetworkEntry => row !== undefined);
  }

  get(requestId: string): NetworkEntry | undefined {
    return this.byId.get(requestId);
  }

  /** Monotonic across eviction AND purge, exactly like the console cursor. */
  count(): number {
    return this.total;
  }

  /**
   * Drop everything captured at or after `since`.
   *
   * The handoff purge. The ring fills from an eager listener that knows
   * nothing about the lease, so the requests a person's own signing-in
   * produced — the login POST, the token refresh, the URLs they visited —
   * would otherwise be readable by the agent the instant they hand back. The
   * console has had this from the start; a ring of URLs needs it at least as
   * much.
   */
  dropSince(since: number): void {
    for (const id of [...this.order]) {
      const row = this.byId.get(id);
      if (row && row.at >= since) {
        this.byId.delete(id);
        this.order.splice(this.order.indexOf(id), 1);
      }
    }
  }
}
