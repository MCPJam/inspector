/**
 * The engine-neutral logical browser-session client.
 *
 * `browserSessions` is a boot/routing cache; this service talks to the durable
 * `browserLogicalSessions` record that survives a daemon restart, a provider
 * change and an inspector replica change. The same small API is usable by the
 * hosted and local engines. When the backend is not configured (a local-only
 * install), callers can keep their existing JSON ledger instead.
 */
import type { BrowserContextMode } from "./browser-sessions-client.js";

export type BrowserSessionOwnerKind =
  "conversation" | "swarm_attempt" | "eval_iteration" | "participant_session";

export interface BrowserSessionOwner {
  kind: BrowserSessionOwnerKind;
  id: string;
}

export type BrowserSessionBox =
  { computerId: string } | { sandboxRowId: string } | { localKey: string };

export interface BrowserLogicalSessionRecord {
  sessionId: string;
  owner: BrowserSessionOwner;
  projectId: string;
  ownerUserId: string;
  engine: string;
  profile: "blank" | `saved:${string}` | string;
  profileId?: string;
  state: "active" | "sleeping" | "closed";
  box?: BrowserSessionBox;
  lastBootId?: string;
  tabs?: Array<{ tabId: string; url: string; title: string }>;
  createdAt: number;
  lastActiveAt: number;
  lastCommandAt: number;
  sleptAt?: number;
  closedAt?: number;
}

export interface BrowserSessionServiceOptions {
  /** Injectable for unit tests and callers with a custom fetch boundary. */
  fetch?: typeof globalThis.fetch;
  /** Base Convex HTTP-actions origin. Defaults to CONVEX_HTTP_URL. */
  baseUrl?: string;
  /** When absent, the service is disabled and callers may use local JSON. */
  enabled?: boolean;
}

type RequestArgs = {
  bearer: string;
  projectId: string;
  body: Record<string, unknown>;
  signal?: AbortSignal;
};

/**
 * A refusal from the browser-session control plane, carrying the backend's own
 * message. Typed so a caller can tell a 409 "this identity is closed" from a
 * transport failure instead of string-matching a thrown message.
 */
export class BrowserSessionServiceError extends Error {
  readonly status: number;
  readonly detail: string;
  constructor(message: string, status: number, detail: string) {
    super(message);
    this.name = "BrowserSessionServiceError";
    this.status = status;
    this.detail = detail;
  }
}

function isLoopbackHost(hostname: string): boolean {
  // WHATWG URL bracket-wraps IPv6 hosts, so the literal form is matched too.
  return (
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "::1" ||
    hostname === "[::1]"
  );
}

/**
 * Refuse to carry a user bearer over cleartext.
 *
 * The same policy `normalizeDataPlaneUrl` already applies to the computers
 * data plane (utils/computers/remote-data-plane.ts), and the one the backend
 * enforces on `/computers/data-plane-url`: http(s) only, and plain `http:`
 * only for loopback, where nothing leaves the machine. This module was the
 * one in the family without it — it posts a user's bearer and pulls back a
 * saved profile archive full of that user's cookies, so a misconfigured
 * `CONVEX_HTTP_URL` could have downgraded both onto the wire in the clear.
 *
 * Thrown, not silently skipped: a deployment pointed at a cleartext origin is
 * misconfigured, and failing loudly at the first call is how that gets found.
 */
function assertSecureTransport(url: URL, source: string): void {
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(
      `${source} must be an http(s) URL (got ${url.protocol.replace(":", "")})`,
    );
  }
  if (url.protocol === "http:" && !isLoopbackHost(url.hostname)) {
    throw new Error(
      `${source} must use https for a non-loopback host (got ${url.origin})`,
    );
  }
}

function bearerHeader(value: string): string {
  return /^Bearer\s/i.test(value) ? value : `Bearer ${value}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function parseBox(value: unknown): BrowserSessionBox | undefined {
  if (!isRecord(value)) return undefined;
  const computerId = value.computerId;
  const sandboxRowId = value.sandboxRowId;
  const localKey = value.localKey;
  const present = [computerId, sandboxRowId, localKey].filter(
    (entry) => typeof entry === "string" && entry.length > 0,
  );
  if (present.length !== 1) return undefined;
  if (typeof computerId === "string" && computerId) return { computerId };
  if (typeof sandboxRowId === "string" && sandboxRowId) return { sandboxRowId };
  return typeof localKey === "string" && localKey ? { localKey } : undefined;
}

function parseSession(value: unknown): BrowserLogicalSessionRecord | null {
  if (!isRecord(value)) return null;
  const owner = value.owner;
  if (!isRecord(owner)) return null;
  if (
    typeof value.sessionId !== "string" ||
    typeof owner.kind !== "string" ||
    typeof owner.id !== "string" ||
    typeof value.projectId !== "string" ||
    typeof value.ownerUserId !== "string" ||
    typeof value.engine !== "string" ||
    typeof value.profile !== "string" ||
    (value.state !== "active" &&
      value.state !== "sleeping" &&
      value.state !== "closed") ||
    typeof value.createdAt !== "number" ||
    typeof value.lastActiveAt !== "number" ||
    typeof value.lastCommandAt !== "number"
  ) {
    return null;
  }
  return {
    sessionId: value.sessionId,
    owner: { kind: owner.kind as BrowserSessionOwnerKind, id: owner.id },
    projectId: value.projectId,
    ownerUserId: value.ownerUserId,
    engine: value.engine,
    profile: value.profile,
    ...(typeof value.profileId === "string"
      ? { profileId: value.profileId }
      : {}),
    state: value.state,
    ...(parseBox(value.box) ? { box: parseBox(value.box) } : {}),
    ...(typeof value.lastBootId === "string"
      ? { lastBootId: value.lastBootId }
      : {}),
    ...(Array.isArray(value.tabs)
      ? { tabs: value.tabs as BrowserLogicalSessionRecord["tabs"] }
      : {}),
    createdAt: value.createdAt,
    lastActiveAt: value.lastActiveAt,
    lastCommandAt: value.lastCommandAt,
    ...(typeof value.sleptAt === "number" ? { sleptAt: value.sleptAt } : {}),
    ...(typeof value.closedAt === "number" ? { closedAt: value.closedAt } : {}),
  };
}

/** A no-op adapter is deliberate: local-only installs must remain functional. */
export class BrowserSessionService {
  private readonly requestFetch: typeof globalThis.fetch;
  private readonly baseUrl: string | undefined;
  readonly enabled: boolean;

  constructor(options: BrowserSessionServiceOptions = {}) {
    this.requestFetch = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.baseUrl = options.baseUrl ?? process.env.CONVEX_HTTP_URL?.trim();
    this.enabled = options.enabled ?? Boolean(this.baseUrl);
  }

  private async post<T>(path: string, args: RequestArgs): Promise<T | null> {
    if (!this.enabled || !this.baseUrl) return null;
    const target = new URL(path, this.baseUrl);
    assertSecureTransport(target, "CONVEX_HTTP_URL");
    const response = await this.requestFetch(target, {
      method: "POST",
      headers: {
        authorization: bearerHeader(args.bearer),
        "content-type": "application/json",
      },
      body: JSON.stringify({ projectId: args.projectId, ...args.body }),
      redirect: "error",
      signal: args.signal,
    });
    if (!response.ok) {
      // The backend's own message is the ONLY useful part of a refusal here —
      // "profile is not owned" tells a user what to change; "route returned
      // 400" tells them nothing and sends whoever is on call reading Convex
      // logs. Body first, status only as the fallback when there is no body.
      const detail = await response
        .text()
        .then((text) => {
          if (!text) return "";
          try {
            const parsed: unknown = JSON.parse(text);
            const message = isRecord(parsed) ? parsed.error : undefined;
            return typeof message === "string" && message ? message : text;
          } catch {
            return text;
          }
        })
        .catch(() => "");
      throw new BrowserSessionServiceError(
        detail
          ? `browser session route ${path} failed: ${detail}`
          : `browser session route ${path} returned ${response.status}`,
        response.status,
        detail,
      );
    }
    return (await response.json()) as T;
  }

  async resolveSession(args: {
    owner: BrowserSessionOwner;
    projectId: string;
    bearer: string;
    engine: string;
    profile: "blank" | `saved:${string}` | string;
    profileId?: string;
    signal?: AbortSignal;
  }): Promise<BrowserLogicalSessionRecord | null> {
    const raw = await this.post<{ session?: unknown }>(
      "/browser-sessions/open",
      {
        bearer: args.bearer,
        projectId: args.projectId,
        signal: args.signal,
        body: {
          owner: args.owner,
          engine: args.engine,
          profile: args.profile,
          ...(args.profileId ? { profileId: args.profileId } : {}),
        },
      },
    );
    return parseSession(raw?.session);
  }

  async bindBox(args: {
    sessionId: string;
    projectId: string;
    bearer: string;
    box: BrowserSessionBox;
    signal?: AbortSignal;
  }): Promise<BrowserLogicalSessionRecord | null> {
    const raw = await this.post<{ session?: unknown }>(
      "/browser-sessions/bind",
      {
        bearer: args.bearer,
        projectId: args.projectId,
        signal: args.signal,
        body: { sessionId: args.sessionId, box: args.box },
      },
    );
    return parseSession(raw?.session);
  }

  async recordBoot(args: {
    sessionId: string;
    projectId: string;
    bearer: string;
    bootId: string;
    signal?: AbortSignal;
  }): Promise<boolean> {
    const raw = await this.post<{ ok?: unknown }>("/browser-sessions/boot", {
      bearer: args.bearer,
      projectId: args.projectId,
      signal: args.signal,
      body: { sessionId: args.sessionId, bootId: args.bootId },
    });
    return raw?.ok === true;
  }

  async touch(args: {
    sessionId: string;
    projectId: string;
    bearer: string;
    kind: "command" | "panel";
    signal?: AbortSignal;
  }): Promise<boolean> {
    const raw = await this.post<{ counted?: unknown }>(
      "/browser-sessions/touch",
      {
        bearer: args.bearer,
        projectId: args.projectId,
        signal: args.signal,
        body: { sessionId: args.sessionId, kind: args.kind },
      },
    );
    return raw?.counted === true;
  }

  async setTabs(args: {
    sessionId: string;
    projectId: string;
    bearer: string;
    tabs: Array<{ tabId: string; url: string; title: string }>;
    signal?: AbortSignal;
  }): Promise<boolean> {
    const raw = await this.post<{ ok?: unknown }>("/browser-sessions/tabs", {
      bearer: args.bearer,
      projectId: args.projectId,
      signal: args.signal,
      body: { sessionId: args.sessionId, tabs: args.tabs },
    });
    return raw?.ok === true;
  }

  async close(args: {
    sessionId: string;
    projectId: string;
    bearer: string;
    signal?: AbortSignal;
  }): Promise<boolean> {
    const raw = await this.post<{ ok?: unknown }>("/browser-sessions/close", {
      bearer: args.bearer,
      projectId: args.projectId,
      signal: args.signal,
      body: { sessionId: args.sessionId },
    });
    return raw?.ok === true;
  }

  /** Resolve and download a saved profile archive for a fresh browser boot. */
  async downloadProfile(args: {
    projectId: string;
    profileId: string;
    bearer: string;
    signal?: AbortSignal;
  }): Promise<Uint8Array | null> {
    const raw = await this.post<{ url?: unknown }>(
      "/browser-profiles/download-url",
      {
        bearer: args.bearer,
        projectId: args.projectId,
        signal: args.signal,
        body: { profileId: args.profileId },
      },
    );
    if (!raw || typeof raw.url !== "string" || !raw.url) return null;
    // The storage URL comes back over the wire, so it gets the same scheme
    // check as the control plane itself. What travels over it is a profile
    // archive — the user's cookies and logged-in sessions — which is the last
    // thing that should ride cleartext because a signed URL happened to say
    // `http:`.
    const downloadUrl = new URL(raw.url);
    assertSecureTransport(downloadUrl, "browser profile download URL");
    const response = await this.requestFetch(downloadUrl, {
      method: "GET",
      redirect: "error",
      signal: args.signal,
    });
    if (!response.ok) {
      throw new Error(`browser profile download returned ${response.status}`);
    }
    return new Uint8Array(await response.arrayBuffer());
  }
}

export type { BrowserContextMode };
