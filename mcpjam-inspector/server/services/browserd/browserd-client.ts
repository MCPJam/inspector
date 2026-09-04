/**
 * The inspector-server → browserd HTTP client: the mirror image of the daemon's
 * request handler (`daemon/request-handler.ts`). Given a booted daemon's public
 * origin + per-boot bearer (from `bootBrowserd`), it sends a `BrowserCommand` to
 * `/v1/commands` and turns the HTTP response back into a typed outcome, and it
 * probes `/healthz`. Everything above it — the debug route, the `browser_*`
 * tools — speaks commands through this client and never touches fetch or
 * status codes directly.
 *
 * This file is now only the TRANSPORT. Every decision about what a reply means
 * lives in `browserd-codec.ts`, shared with the in-process client the local and
 * Electron engines use, so a daemon reply cannot mean two different things
 * depending on which engine received it. The types are re-exported here so the
 * client remains the one import site callers already know.
 *
 * The `expectedBootId` a caller passes is echoed to the daemon so a command
 * replayed against a DIFFERENT boot is rejected (`unknown_boot`) rather than
 * re-run; the caller learns the current bootId from every response and stores it.
 */
import type { BrowserCommand } from "./protocol";
import {
  asRecord,
  decodeCommandResponse,
  decodeHealth,
  decodeLease,
  decodeLeaseAction,
  decodeStatus,
  type BrowserdCommandResponse,
  type BrowserdHealth,
  type BrowserdLeaseState,
  type BrowserdStatus,
} from "./browserd-codec";

export {
  BrowserdClientError,
  type BrowserdCommandResponse,
  type BrowserdHealth,
  type BrowserdLeaseHolderKind,
  type BrowserdLeaseState,
  type BrowserdStatus,
} from "./browserd-codec";

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

/**
 * Longer than any single daemon operation, deliberately.
 *
 * The daemon's own budgets stack: a navigation may take 30s to commit, then
 * settle for up to 10s, and an act adds 15s of its own before the observation
 * that follows it. A 30s client timeout aborted commands the daemon was still
 * legitimately running — and an aborted command is the worst kind, because the
 * daemon completes it anyway (its `commandId` is spent) while the caller
 * believes it failed. This is a backstop against a wedged socket, not a
 * second, shorter deadline competing with the daemon's.
 */
const DEFAULT_TIMEOUT_MS = 75_000;

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
    return decodeHealth({ status: res.status, body: await this.json(res) });
  }

  /** Probe the authenticated `/v1/status`: liveness + bootId + bearer check. */
  async status(): Promise<BrowserdStatus> {
    const res = await this.request("/v1/status", { method: "GET" }, true);
    return decodeStatus({ status: res.status, body: await this.json(res) });
  }

  /** Read the handoff lease without changing it. */
  async lease(): Promise<BrowserdLeaseState> {
    const res = await this.request("/v1/lease", { method: "GET" }, true);
    return decodeLease({ status: res.status, body: await this.json(res) });
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
    /** What is taking it — a person at the pane, or a script over CDP. */
    kind?: "human" | "script";
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
    return decodeLeaseAction({ status: res.status, body: await this.json(res) });
  }

  /** Send a command and interpret the daemon's reply. */
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
    return decodeCommandResponse({
      status: res.status,
      body: await this.json(res),
    });
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
      return asRecord(await res.json());
    } catch {
      return {};
    }
  }
}
