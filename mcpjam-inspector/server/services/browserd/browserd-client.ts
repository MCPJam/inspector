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

import {
  createFrameStreamDecoder,
  FRAME_STREAM_KIND,
  type FrameStreamFrame,
  type FrameStreamStats,
  type FrameStreamVideo,
} from "./frame-stream.js";
import type { ViewportInputEvent } from "./daemon/viewport.js";

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

/**
 * How long to wait for the frame stream's HEADERS. Bounded, unlike its body.
 */
const CONNECT_TIMEOUT_MS = 15_000;

/**
 * What `/v1/record` is asked to do.
 *
 * ONE method for both actions, mirroring the route, so a `SessionClient` that
 * can start a recording can always also stop one. Splitting them cost nothing
 * at the daemon and everything at the seam below, where a client is rebuilt
 * method by method and a forwarded `start` with a forgotten `stop` is a run
 * that records forever and collects nothing.
 */
export type BrowserdRecordArgs =
  | {
      action: "start";
      /** Names the file in the daemon's recording dir. A plain filename. */
      id: string;
      /** 1..30; the daemon defaults to 15 when omitted. */
      fps?: number;
    }
  | { action: "stop" };

/** What one finished take left on the box. */
export interface BrowserdRecording {
  path: string;
  bytes: number;
  durationMs: number;
  /** Frames written AFTER decimation — small on a static page, by design. */
  distinctFrames: number;
  /** The take ended before anything asked it to (the size cap, or a crash). */
  truncated: boolean;
}

/**
 * A RESULT rather than a throw, like `setQuality`.
 *
 * A box with no ffmpeg, or one already recording, is a normal answer on this
 * route — and a caller that surfaced either as a failure would be reporting a
 * run working exactly as designed.
 */
export type BrowserdRecordResult =
  | {
      ok: true;
      /**
       * What a `stop` found on disk; `null` when nothing was recording, and
       * absent on a `start`. Present-and-null is a real answer here: a take
       * that hit its size cap five minutes ago has already ended, and a
       * collector on a teardown path needs to read that rather than treat it
       * as an error.
       */
      recording?: BrowserdRecording | null;
    }
  | { ok: false; status: number; error: string };

/** What the daemon says is recording right now. */
export interface BrowserdRecordState {
  active: boolean;
  id?: string;
  fps?: number;
  startedAtMs?: number;
  distinctFrames?: number;
}

/**
 * How long a frame stream may be completely silent before it is written off.
 *
 * Comfortably more than the daemon's 10s heartbeat: a stream that has gone
 * quiet for this long is not slow, it is gone.
 */
const IDLE_TIMEOUT_MS = 30_000;

export class BrowserdClient {
  private readonly baseUrl: string;
  private readonly bearer: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(config: BrowserdClientConfig) {
    // Normalise so `${baseUrl}/path` never doubles a slash.
    this.baseUrl = config.baseUrl.replace(/\/+$/, "");
    // HTTPS OR NOTHING. Every request below attaches the per-boot bearer, and
    // that bearer is full control of somebody's browser — commands, input, and
    // a live stream of whatever is on the page. The origin comes from a
    // control-plane row that is validated as a non-empty string and nothing
    // more, so the one place that can insist on the scheme is here, before a
    // single request goes out. Refused loudly rather than downgraded: a client
    // that quietly spoke cleartext would leak the credential on every call.
    if (!/^https:\/\//i.test(this.baseUrl)) {
      throw new Error(
        `browserd origin must be https (got ${new URL(this.baseUrl).protocol})`,
      );
    }
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
    return decodeLeaseAction({
      status: res.status,
      body: await this.json(res),
    });
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

  /**
   * Forward a person's pointer and keys to `POST /v1/input`.
   *
   * A REFUSAL IS A NORMAL ANSWER, not an error, which is why this returns a
   * result instead of throwing. `423` means the lease is not this holder's —
   * the ordinary state of affairs while the agent is driving — and a pane that
   * surfaced it as a failure would be reporting a browser that is working
   * exactly as designed. Only the transport itself throws.
   *
   * Batched, and NOT routed through `sendCommand`: a drag emits input twenty
   * times a second, and every command spends an idempotency slot from a ledger
   * that stops issuing ids once exhausted.
   */
  async sendInput(args: {
    holder: string;
    events: readonly ViewportInputEvent[];
    tabId?: string;
  }): Promise<{ ok: true } | { ok: false; status: number; error: string }> {
    const res = await this.request(
      "/v1/input",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          holder: args.holder,
          events: args.events,
          ...(args.tabId ? { tabId: args.tabId } : {}),
        }),
      },
      true,
    );
    if (res.ok) return { ok: true };
    const body = await this.json(res);
    return {
      ok: false,
      status: res.status,
      error: typeof body.error === "string" ? body.error : `http_${res.status}`,
    };
  }

  /**
   * Ask the daemon to re-encode at a different tier.
   *
   * A RESULT rather than a throw, like `sendInput`: a box with no encoder is a
   * normal answer, and a pane that surfaced it as a failure would be reporting
   * a browser working exactly as designed.
   */
  async setQuality(args: {
    tier: "auto" | "sharp" | "saver";
  }): Promise<{ ok: true } | { ok: false; status: number; error: string }> {
    const res = await this.request(
      "/v1/policy",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ tier: args.tier }),
      },
      true,
    );
    if (res.ok) return { ok: true };
    const body = await this.json(res);
    return {
      ok: false,
      status: res.status,
      error: typeof body.error === "string" ? body.error : `http_${res.status}`,
    };
  }

  /**
   * Start or stop the display recording on the box.
   *
   * A RESULT rather than a throw, like `setQuality` above: a daemon with no
   * ffmpeg answers 503 and one already recording answers 409, and both are
   * ordinary states of a run rather than failures of it. The caller decides
   * (it logs and carries on without a video).
   */
  async record(args: BrowserdRecordArgs): Promise<BrowserdRecordResult> {
    const res = await this.request(
      "/v1/record",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(
          args.action === "start"
            ? {
                action: "start",
                id: args.id,
                ...(args.fps === undefined ? {} : { fps: args.fps }),
              }
            : { action: "stop" },
        ),
      },
      true,
    );
    if (!res.ok) {
      return { ok: false, status: res.status, error: await this.errorOf(res) };
    }
    if (args.action === "start") return { ok: true };
    const body = await this.json(res);
    return { ok: true, recording: decodeRecording(body.recording) };
  }

  /** What is recording right now. `{active:false}` on any answer it cannot read. */
  async recordStatus(): Promise<BrowserdRecordState> {
    const res = await this.request("/v1/record", { method: "GET" }, true);
    if (!res.ok) return { active: false };
    const body = await this.json(res);
    return {
      active: body.active === true,
      ...(typeof body.id === "string" ? { id: body.id } : {}),
      ...(typeof body.fps === "number" ? { fps: body.fps } : {}),
      ...(typeof body.startedAtMs === "number"
        ? { startedAtMs: body.startedAtMs }
        : {}),
      ...(typeof body.distinctFrames === "number"
        ? { distinctFrames: body.distinctFrames }
        : {}),
    };
  }

  /**
   * Read `GET /v1/frames` until it ends.
   *
   * Resolves when the CONNECTION is established (or refused); frames then
   * arrive by callback until `onEnd`. The caller owns the lifetime through
   * `signal` — this never stops on its own while bytes keep coming.
   *
   * THE 75s TIMEOUT IS NOT USED HERE, and that is the whole reason this has its
   * own path rather than going through `request()`. `AbortSignal.timeout` stays
   * attached to a streamed body, so a stream routed through the ordinary helper
   * would die at 75 seconds on the dot — forever, silently, and only under a
   * real socket, which is to say never in a unit test. What it gets instead is
   * a CONNECT-only deadline, cleared the instant the response resolves.
   *
   * The idle watchdog is the other half. A connection can be black-holed — an
   * edge that went away, a box that hibernated — leaving a socket that is open
   * and permanently silent. The daemon heartbeats, so silence past a couple of
   * intervals means the link is gone, and saying so turns "the pane froze" into
   * "the pane reconnected".
   */
  async streamFrames(args: {
    tabId?: string;
    holder?: string;
    /**
     * `"h264"` asks for the display encoder instead of the tab's screencast.
     *
     * REQUESTED ONLY when the daemon advertised `"h264"` in its
     * `/v1/status.features`. A daemon too old to encode would answer an error
     * stream, and a reader cannot tell that apart from a dead browser.
     *
     * `tabId` is ignored alongside it: the encoder grabs the X display, which
     * has no concept of a tab. Per-tab watching stays JPEG.
     */
    codec?: "jpeg" | "h264";
    /** One H.264 access unit. Only called on a `codec: "h264"` stream. */
    onVideo?: (record: FrameStreamVideo) => void;
    /** Caller's lifetime. Aborting is how a reader hangs up. */
    signal: AbortSignal;
    onFrame: (frame: FrameStreamFrame) => void;
    /**
     * The daemon's own counters, as they ride the heartbeat.
     *
     * OPTIONAL on both sides: a daemon predating V-4a sends a bare heartbeat,
     * and a caller that does not care simply omits this. Never inferred — an
     * absent number is unknown, not zero.
     */
    onStats?: (stats: FrameStreamStats) => void;
    /**
     * How the stream ended. `undefined` means it stopped without saying —
     * a drop, which a caller should retry, as opposed to a refusal it should
     * respect.
     */
    onEnd: (reason: string | undefined) => void;
    /** Give up after this long with no bytes at all. */
    idleMs?: number;
    connectMs?: number;
  }): Promise<{ ok: true } | { ok: false; status: number; error: string }> {
    const query = new URLSearchParams();
    // DROPPED on a video stream, here rather than at the call site: the
    // encoder grabs the X display, which has no concept of a tab, so sending
    // one would be a request the daemon cannot honour and a promise the caller
    // would read as kept. Per-tab watching is JPEG.
    if (args.tabId && args.codec !== "h264") query.set("tabId", args.tabId);
    if (args.holder) query.set("holder", args.holder);
    if (args.codec === "h264") query.set("codec", "h264");
    const suffix = query.toString() ? `?${query}` : "";

    // Checked BEFORE anything is opened. `addEventListener("abort")` does not
    // replay an abort that already happened, so a caller who cancelled before
    // this call — a pane closed while the token was still being minted — would
    // otherwise have a connection opened on its behalf and frames delivered
    // into a reader that has gone.
    if (args.signal.aborted) {
      return { ok: false, status: 0, error: "aborted" };
    }

    const connect = new AbortController();
    const onCallerAbort = () => connect.abort();
    args.signal.addEventListener("abort", onCallerAbort, { once: true });
    const connectTimer = setTimeout(
      () => connect.abort(),
      args.connectMs ?? CONNECT_TIMEOUT_MS,
    );

    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}/v1/frames${suffix}`, {
        headers: { authorization: `Bearer ${this.bearer}` },
        signal: connect.signal,
      });
    } catch (error) {
      args.signal.removeEventListener("abort", onCallerAbort);
      return {
        ok: false,
        status: 0,
        error: error instanceof Error ? error.message : String(error),
      };
    } finally {
      // Cleared the moment headers are in: from here the body may take as long
      // as it likes.
      clearTimeout(connectTimer);
    }

    if (!res.ok || !res.body) {
      args.signal.removeEventListener("abort", onCallerAbort);
      // A refusal still arrives with a body, and an uncancelled one holds its
      // socket until the garbage collector happens to notice. `503
      // too_many_watchers` is a ROUTINE answer here — the daemon serves four
      // streams — so this is the path a pane retries into, and every retry
      // would strand a connection to a box the agent is also using.
      void res.body?.cancel().catch(() => {});
      return {
        ok: false,
        status: res.status,
        error: res.ok ? "no_body" : `http_${res.status}`,
      };
    }

    void this.pump(res.body, args).finally(() => {
      args.signal.removeEventListener("abort", onCallerAbort);
    });
    return { ok: true };
  }

  private async pump(
    body: ReadableStream<Uint8Array>,
    args: {
      signal: AbortSignal;
      codec?: "jpeg" | "h264";
      onFrame: (frame: FrameStreamFrame) => void;
      onVideo?: (record: FrameStreamVideo) => void;
      onStats?: (stats: FrameStreamStats) => void;
      onEnd: (reason: string | undefined) => void;
      idleMs?: number;
    },
  ): Promise<void> {
    // Video records are accepted only on a stream that ASKED for them, exactly
    // as the daemon's own reader does it: an unknown kind stays fatal, which is
    // what protects a reader that negotiated nothing.
    const decoder = createFrameStreamDecoder(
      args.codec === "h264" ? { video: true } : {},
    );
    const reader = body.getReader();
    let reason: string | undefined;
    let idleTimer: ReturnType<typeof setTimeout> | undefined;
    const armIdle = () => {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(
        () => void reader.cancel().catch(() => {}),
        args.idleMs ?? IDLE_TIMEOUT_MS,
      );
    };
    const stop = () => void reader.cancel().catch(() => {});
    args.signal.addEventListener("abort", stop, { once: true });

    try {
      armIdle();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        armIdle();
        const decoded = decoder.push(value);
        if (!decoded.ok) {
          // A reader that has lost its place in a byte stream can never find it
          // again, so the connection goes rather than the record.
          reason = undefined;
          break;
        }
        for (const record of decoded.records) {
          if (record.kind === FRAME_STREAM_KIND.frame) args.onFrame(record);
          else if (
            record.kind === FRAME_STREAM_KIND.video_key ||
            record.kind === FRAME_STREAM_KIND.video_delta
          ) {
            args.onVideo?.(record);
          } else if (record.kind === FRAME_STREAM_KIND.heartbeat) {
            if (record.stats) args.onStats?.(record.stats);
          } else if (record.kind === FRAME_STREAM_KIND.end)
            reason = record.reason;
        }
        if (reason !== undefined) break;
      }
    } catch {
      reason = undefined; // aborted or dropped: unexplained, by definition
    } finally {
      clearTimeout(idleTimer);
      args.signal.removeEventListener("abort", stop);
      stop();
      args.onEnd(reason);
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

  /** The daemon's own error code, or the bare status when it sent none. */
  private async errorOf(res: Response): Promise<string> {
    const body = await this.json(res);
    return typeof body.error === "string" ? body.error : `http_${res.status}`;
  }

  private async json(res: Response): Promise<Record<string, unknown>> {
    try {
      return asRecord(await res.json());
    } catch {
      return {};
    }
  }
}

/**
 * Decode the `recording` a stop answered with.
 *
 * Field by field, and `null` for anything that does not carry the whole shape:
 * a partially-decoded recording would flow into the evidence pipe as a video
 * with a zero duration and no frame count, which reads on the trace page as a
 * broken take rather than as a daemon that answered something unexpected.
 */
function decodeRecording(value: unknown): BrowserdRecording | null {
  if (typeof value !== "object" || value === null) return null;
  const raw = value as Record<string, unknown>;
  // EVERY field, or none. Defaulting a missing `durationMs` to 0 and a missing
  // `truncated` to `false` does not degrade gracefully — it INVENTS the two
  // claims a reader most relies on, and they travel into the trace page as a
  // stated duration and an absent badge. "This take completed and ran for no
  // time" is a worse answer than "this daemon said something I cannot read".
  if (typeof raw.path !== "string") return null;
  if (typeof raw.bytes !== "number") return null;
  if (typeof raw.durationMs !== "number") return null;
  if (typeof raw.distinctFrames !== "number") return null;
  if (typeof raw.truncated !== "boolean") return null;
  return {
    path: raw.path,
    bytes: raw.bytes,
    durationMs: raw.durationMs,
    distinctFrames: raw.distinctFrames,
    truncated: raw.truncated,
  };
}
