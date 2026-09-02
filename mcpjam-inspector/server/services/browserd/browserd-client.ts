/**
 * The inspector-server → browserd HTTP client: the mirror image of the daemon's
 * request handler (`daemon/request-handler.ts`). Given a booted daemon's public
 * origin + per-boot bearer (from `bootBrowserd`), it sends a `BrowserCommand` to
 * `/v1/commands` and turns the HTTP response back into a typed outcome, and it
 * probes `/healthz`. Everything above it — the debug route now, the `browser_*`
 * tools in W3 — speaks commands through this client and never touches fetch or
 * status codes directly.
 *
 * The `expectedBootId` a caller passes is echoed to the daemon so a command
 * replayed against a DIFFERENT boot is rejected (`unknown_boot`) rather than
 * re-run; the caller learns the current bootId from every response and stores it.
 */
import type { BrowserCommand, BrowserCommandResult } from "./protocol";

/** The daemon's reply, reconstructed from the HTTP status + body. Distinct from
 *  the queue's `BrowserCommandOutcome`: it also carries the two boundary-only
 *  rejections (`stale_observation`, `unknown_boot`) the handler maps to 409. */
export type BrowserdCommandResponse =
  | { status: "ok"; result: BrowserCommandResult; bootId: string }
  | { status: "busy"; bootId: string }
  | { status: "expired"; bootId: string }
  | { status: "at_capacity"; bootId: string }
  | {
      status: "stale_observation";
      result?: BrowserCommandResult;
      bootId: string;
    }
  | { status: "unknown_boot"; bootId: string }
  /** A person is holding (or has parked) the browser — see `daemon/lease.ts`.
   *  Not an error: the correct response is to wait and tell the user, which is
   *  why it is a normal outcome variant rather than a thrown client error. */
  | {
      status: "lease_blocked";
      lease: "held" | "parked";
      holder?: string;
      bootId: string;
    };

export interface BrowserdHealth {
  ok: boolean;
  detail?: string;
}

/** The authenticated `/v1/status` verdict — liveness, boot identity, and the
 *  bearer's validity in one probe. `unauthorized` means the bearer this client
 *  holds is not the running daemon's secret (a relaunch signal for the durable
 *  session path, same as a bootId mismatch). */
export type BrowserdStatus =
  | { kind: "ok"; bootId: string }
  | { kind: "unhealthy"; bootId?: string; detail?: string }
  | { kind: "unauthorized" };

/** The daemon's handoff-lease state, as this client reports it. */
export type BrowserdLeaseState =
  | { state: "free"; bootId: string }
  | { state: "held"; holder: string; expiresAt?: number; bootId: string }
  | { state: "parked"; holder: string; bootId: string };

/** browserd answered with a status the client cannot interpret (e.g. 401/400).
 *  These are bugs in the boot wiring, not normal protocol signals, so they throw
 *  rather than becoming a response variant. */
export class BrowserdClientError extends Error {
  constructor(
    message: string,
    readonly httpStatus: number,
  ) {
    super(message);
    this.name = "BrowserdClientError";
  }
}

export interface BrowserdClientConfig {
  /** The daemon's public origin, e.g. `https://box-8791.e2b.dev`. */
  baseUrl: string;
  /** The per-boot bearer minted at boot; presented on every request. */
  bearer: string;
  /** Injectable for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /** Per-request timeout. */
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 30_000;

export class BrowserdClient {
  private readonly baseUrl: string;
  private readonly bearer: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(config: BrowserdClientConfig) {
    // Normalise so `${baseUrl}/path` never doubles a slash.
    this.baseUrl = config.baseUrl.replace(/\/+$/, "");
    this.bearer = config.bearer;
    this.fetchImpl = config.fetchImpl ?? fetch;
    this.timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  /** Probe `/healthz` (unauthenticated). A dead browser is 503 → `{ok:false}`. */
  async health(): Promise<BrowserdHealth> {
    const res = await this.request("/healthz", { method: "GET" }, false);
    const body = (await this.json(res)) as { ok?: unknown; detail?: unknown };
    return {
      ok: res.status === 200 && body?.ok === true,
      detail: typeof body?.detail === "string" ? body.detail : undefined,
    };
  }

  /** Probe the authenticated `/v1/status`: liveness + bootId + bearer check. */
  async status(): Promise<BrowserdStatus> {
    const res = await this.request("/v1/status", { method: "GET" }, true);
    const body = (await this.json(res)) as {
      ok?: unknown;
      bootId?: unknown;
      detail?: unknown;
    };
    const bootId = typeof body.bootId === "string" ? body.bootId : undefined;
    switch (res.status) {
      case 200:
        return bootId
          ? { kind: "ok", bootId }
          : { kind: "unhealthy", detail: "status_missing_boot_id" };
      case 503:
        return {
          kind: "unhealthy",
          bootId,
          detail: typeof body.detail === "string" ? body.detail : undefined,
        };
      case 401:
        return { kind: "unauthorized" };
      default:
        throw new BrowserdClientError(
          `browserd status probe failed (HTTP ${res.status})`,
          res.status,
        );
    }
  }

  /** Read the handoff lease without changing it. */
  async lease(): Promise<BrowserdLeaseState> {
    const res = await this.request("/v1/lease", { method: "GET" }, true);
    return this.leaseFrom(res, await this.json(res));
  }

  /**
   * Act on the handoff lease. `acquire` can legitimately fail (someone else
   * holds it), and that is reported as `{ took: false }` rather than thrown:
   * a UI that treated a refusal as an error would be as wrong as one that
   * treated it as success.
   */
  async leaseAction(args: {
    action: "acquire" | "heartbeat" | "resume";
    holder: string;
    ttlMs?: number;
  }): Promise<{ took: boolean; lease: BrowserdLeaseState }> {
    const res = await this.request(
      "/v1/lease",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(args),
      },
      true,
    );
    const body = await this.json(res);
    const lease = this.leaseFrom(res, body);
    if (res.status === 200) return { took: true, lease };
    if (res.status === 409) return { took: false, lease };
    throw new BrowserdClientError(
      `browserd rejected the lease action (HTTP ${res.status}${
        typeof body.error === "string" ? `, ${body.error}` : ""
      })`,
      res.status,
    );
  }

  /** Parse a `{ lease, bootId }` body, failing closed to `free` only on a 2xx. */
  private leaseFrom(
    res: Response,
    body: Record<string, unknown>,
  ): BrowserdLeaseState {
    if (res.status !== 200 && res.status !== 409) {
      throw new BrowserdClientError(
        `browserd lease read failed (HTTP ${res.status})`,
        res.status,
      );
    }
    const bootId = typeof body.bootId === "string" ? body.bootId : "";
    const raw = body.lease;
    if (!raw || typeof raw !== "object") return { state: "free", bootId };
    const lease = raw as {
      state?: unknown;
      holder?: unknown;
      expiresAt?: unknown;
    };
    const holder = typeof lease.holder === "string" ? lease.holder : undefined;
    if (lease.state === "held" && holder) {
      return {
        state: "held",
        holder,
        expiresAt:
          typeof lease.expiresAt === "number" ? lease.expiresAt : undefined,
        bootId,
      };
    }
    if (lease.state === "parked" && holder) {
      return { state: "parked", holder, bootId };
    }
    return { state: "free", bootId };
  }

  /**
   * Send a command and interpret the daemon's reply.
   *
   * `options.timeoutMs` overrides the client-wide deadline for THIS command.
   * Not every command is the same size: an observation is a round trip, while
   * `webmcp_invoke` is synchronous in the daemon and does not answer until the
   * page tool has settled — up to the 60s the daemon allows it. Under the
   * client's flat 30s that call was aborted at the transport while the tool
   * was still running perfectly well, and the caller was told "the browser
   * rejected the command".
   */
  async sendCommand(
    command: BrowserCommand,
    expectedBootId?: string,
    options?: { timeoutMs?: number },
  ): Promise<BrowserdCommandResponse> {
    const res = await this.request(
      "/v1/commands",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ command, expectedBootId }),
      },
      true,
      options?.timeoutMs,
    );
    const body = (await this.json(res)) as Record<string, unknown>;
    const bootId = typeof body.bootId === "string" ? body.bootId : "";

    switch (res.status) {
      case 200:
        return {
          status: "ok",
          result: body.result as BrowserCommandResult,
          bootId,
        };
      case 429:
        return { status: "busy", bootId };
      case 503:
        return { status: "at_capacity", bootId };
      case 423:
        // The privacy gate: a person has the browser. Nothing ran and — the
        // point of enforcing it at the daemon — nothing was observed.
        return {
          status: "lease_blocked",
          lease: body.error === "lease_parked" ? "parked" : "held",
          holder: typeof body.holder === "string" ? body.holder : undefined,
          bootId,
        };
      case 409:
        if (body.error === "stale_observation") {
          return {
            status: "stale_observation",
            result: body.result as BrowserCommandResult | undefined,
            bootId,
          };
        }
        if (body.error === "command_unknown_boot") {
          return { status: "unknown_boot", bootId };
        }
        return { status: "expired", bootId };
      default:
        // 401 (bad bearer), 400 (bad envelope), or anything else: a wiring bug,
        // not a protocol signal.
        throw new BrowserdClientError(
          `browserd rejected the command (HTTP ${res.status}${
            typeof body.error === "string" ? `, ${body.error}` : ""
          })`,
          res.status,
        );
    }
  }

  private async request(
    path: string,
    init: RequestInit,
    authenticated: boolean,
    timeoutMs?: number,
  ): Promise<Response> {
    const headers = new Headers(init.headers);
    if (authenticated) headers.set("authorization", `Bearer ${this.bearer}`);
    return this.fetchImpl(`${this.baseUrl}${path}`, {
      ...init,
      headers,
      signal: AbortSignal.timeout(timeoutMs ?? this.timeoutMs),
    });
  }

  private async json(res: Response): Promise<Record<string, unknown>> {
    try {
      const parsed: unknown = await res.json();
      // A daemon that answers `null`, a scalar, or an array is not speaking
      // this protocol — but neither is it a reason to throw a TypeError from a
      // field read three lines later (the session reuse path reads `bootId`
      // straight off this). Normalize every non-record body to "no fields".
      return parsed !== null &&
        typeof parsed === "object" &&
        !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : {};
    } catch {
      return {};
    }
  }
}
