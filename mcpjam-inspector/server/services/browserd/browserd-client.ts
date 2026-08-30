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
  | { status: "stale_observation"; result?: BrowserCommandResult; bootId: string }
  | { status: "unknown_boot"; bootId: string };

export interface BrowserdHealth {
  ok: boolean;
  detail?: string;
}

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

  /** Send a command and interpret the daemon's reply. */
  async sendCommand(
    command: BrowserCommand,
    expectedBootId?: string,
  ): Promise<BrowserdCommandResponse> {
    const res = await this.request(
      "/v1/commands",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ command, expectedBootId }),
      },
      true,
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
  ): Promise<Response> {
    const headers = new Headers(init.headers);
    if (authenticated) headers.set("authorization", `Bearer ${this.bearer}`);
    return this.fetchImpl(`${this.baseUrl}${path}`, {
      ...init,
      headers,
      signal: AbortSignal.timeout(this.timeoutMs),
    });
  }

  private async json(res: Response): Promise<Record<string, unknown>> {
    try {
      return (await res.json()) as Record<string, unknown>;
    } catch {
      return {};
    }
  }
}
