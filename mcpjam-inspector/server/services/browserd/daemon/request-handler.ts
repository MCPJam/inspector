/**
 * browserd's HTTP control plane — the pure request handler.
 *
 * It wraps PR (a)'s command queue with the wire concerns the daemon boundary
 * owns, and NOTHING else:
 *
 *   - per-request bearer auth (every endpoint is public over `getHost`);
 *   - `bootId` identity: the daemon mints one per process start and echoes it on
 *     every response, and REJECTS a command whose caller expected a different
 *     boot (`command_unknown_boot`) rather than re-running it — the first
 *     execution's fate across a restart is unknowable, so replaying would lie;
 *   - mapping the queue's `BrowserCommandOutcome` to an HTTP status;
 *   - surfacing the L3 stale-observation refusal as `409 stale_observation`.
 *
 * It is transport-agnostic: it takes a parsed `DaemonRequest` and returns a
 * `DaemonResponse`, so it is unit-testable without a socket. The thin Node-http
 * adapter that reads the body and writes the response lives in `server.ts`.
 */
import {
  BROWSERD_PROTOCOL_VERSION,
  BROWSERD_WEBMCP_FEATURES,
  type WebMcpToolsRevision,
  parseBrowserdErrorCode,
  type BrowserCommand,
  type BrowserCommandOutcome,
} from "../protocol";
import type { CommandQueue } from "./command-queue";
import type { BrowserDriver } from "./browser-driver";
import type {
  ViewportCounters,
  ViewportFrame,
  ViewportInputEvent,
} from "./viewport";
import { constantTimeEquals, presentedBearer } from "./auth";
import {
  DEFAULT_RECORD_FPS,
  MAX_RECORD_FPS,
  MIN_RECORD_FPS,
  type VideoRecorder,
} from "./video-recorder";
import {
  HandoffLease,
  leaseRefusalFor,
  type LeaseHolderKind,
  type LeaseRefusal,
  type LeaseState,
} from "./lease";

/**
 * The most input events one request may carry.
 *
 * Mirrors `INPUT_BATCH_LIMIT` at the inspector's own edge
 * (`routes/mcp/computers.ts`), deliberately duplicated rather than shared: this
 * daemon answers on a public host of its own, so a cap enforced only by the
 * caller is a cap that is not enforced.
 */
const MAX_INPUT_EVENTS = 64;

/**
 * The frame interval activity buys, and for how long.
 *
 * 33ms is 30fps — the ceiling the transports can actually carry — and 1.5s is
 * long enough to cover the echo of a gesture and the settle after it without
 * keeping a page at full rate because somebody clicked once.
 *
 * Named for ACTIVITY rather than for input, because the frame rate should not
 * depend on whose hands moved the page. The throttle's 100ms floor is 10fps,
 * and a scroll at 10fps is a slideshow whether a person drove it or the agent
 * did — a watcher seeing the model work deserves the same picture the person
 * driving gets.
 */
const ACTIVITY_BOOST_INTERVAL_MS = 33;
const ACTIVITY_BOOST_WINDOW_MS = 1_500;

/**
 * The actions that move the picture, and so are worth the boost.
 *
 * `observe` is the deliberate omission: it reads the page and changes nothing
 * on it, so raising the frame rate after one buys 45 extra JPEG encodes of a
 * picture that did not move. The `webmcp_*` verbs are omitted for the same
 * reason — they call a page's own tool, which may repaint or may not, and the
 * repaint (if any) arrives through the ordinary screencast.
 */
const MOTION_ACTIONS: ReadonlySet<string> = new Set([
  "navigate",
  "back",
  "reload",
  "act",
]);

/** A parsed inbound request; the adapter fills this from a Node req. */
export interface DaemonRequest {
  method: string;
  path: string;
  /** The `origin` header value, if any. Any value fails the rebinding check. */
  origin: string | undefined;
  /** The raw `authorization` header value, if any. */
  authorization: string | undefined;
  /** The raw request body (already size-limited by the adapter). */
  body: string;
  /**
   * The URL's query, when the adapter bothered to parse it.
   *
   * Optional because nothing routed through `handle` reads it — the JSON API
   * takes its arguments in the body. It exists for the STREAMING route, which
   * the adapter serves itself (a chunked response cannot come back as a
   * `DaemonResponse`) and which needs `tabId`/`holder` before it can subscribe.
   */
  query?: URLSearchParams;
}

/** What the handler wants written back. `body` undefined → empty response. */
export interface DaemonResponse {
  status: number;
  body?: unknown;
  headers?: Record<string, string>;
}

/** The shape of a `POST /v1/commands` body. */
interface CommandRequestBody {
  command: BrowserCommand;
  /**
   * The bootId the caller believes it is talking to. Absent on first contact
   * (the caller learns the current bootId from the response); present on a retry
   * so a replay against a fresh boot is rejected rather than re-executed.
   */
  expectedBootId?: string;
}

export interface BrowserdHandlerDeps {
  queue: Pick<CommandQueue, "submit">;
  driver: Pick<
    BrowserDriver,
    | "health"
    | "viewport"
    | "viewportIfWatched"
    | "tabsSnapshot"
    | "webmcpToolsSnapshot"
  >;
  /** Minted once per daemon process start; echoed on every response. */
  bootId: string;
  /** The shared secret every non-`/healthz` request must present. */
  token: string;
  /**
   * The human-handoff lease. While a person holds (or has parked) it, every
   * model-driven command is refused HERE — before the queue, before the
   * driver, before anything captures a frame. Enforcing it at the daemon is
   * the whole privacy guarantee: a filter further downstream would already
   * hold the screenshot of someone's password field.
   */
  lease?: HandoffLease;
  /**
   * What this daemon can do beyond the baseline protocol.
   *
   * Additive capabilities are ANNOUNCED, never assumed: a relay that asked for
   * `codec=h264` from a daemon too old to encode it would get an error stream
   * instead of a picture, and the reader has no way to tell that apart from a
   * dead browser. Empty here; `"h264"` arrives with the video encoder.
   */
  features?: readonly string[];
  /**
   * The sha256 of the running bundle, for OBSERVABILITY and the lazy-upgrade
   * decision — never for admission. See `BROWSERD_PROTOCOL_VERSION`.
   */
  bundleHash?: string;
  /** Which profile mode this daemon launched with. */
  contextMode?: "persistent" | "ephemeral";
  /**
   * Did the box start this daemon itself (baked into the image), or did an
   * inspector replica boot it? Only `"prelaunch"` is adoptable without a boot.
   */
  startedBy?: "prelaunch" | "inspector";
  /**
   * Re-encode at a different tier.
   *
   * Absent on a box with no encoder, where `/v1/policy` is a no-op that still
   * answers 200 — the caller's picture is a JPEG, whose quality this endpoint
   * does not govern.
   */
  setVideoTier?: (tier: "auto" | "sharp" | "saver") => void;
  /**
   * Record the display to a file, as run evidence.
   *
   * Absent on a box with no recorder (no display, or the operator's kill
   * switch), where `/v1/record` answers 503 `record_unavailable` — and
   * `features` omits `"record"` in the first place, so a caller that reads the
   * status before asking never gets there.
   */
  recorder?: Pick<VideoRecorder, "start" | "stop" | "status">;
}

/** A recording id is a FILENAME. Nothing outside this may reach the path. */
const RECORD_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

export class BrowserdRequestHandler {
  private readonly queue: Pick<CommandQueue, "submit">;
  private readonly driver: Pick<
    BrowserDriver,
    | "health"
    | "viewport"
    | "viewportIfWatched"
    | "tabsSnapshot"
    | "webmcpToolsSnapshot"
  >;
  private readonly bootId: string;
  private readonly token: string;
  private readonly lease: HandoffLease;
  private readonly features: readonly string[];
  private readonly bundleHash: string | undefined;
  private readonly contextMode: "persistent" | "ephemeral" | undefined;
  private readonly startedBy: "prelaunch" | "inspector";
  private readonly setVideoTier: BrowserdHandlerDeps["setVideoTier"];
  private readonly recorder: BrowserdHandlerDeps["recorder"];
  /**
   * How many frame streams are open, asked of the stream host.
   *
   * A FUNCTION set after construction, because the stream host is built from
   * this handler (it borrows `authorize` and `subscribeFrames`) and so cannot
   * exist yet when the constructor runs. Absent until then, which reads as
   * "unknown" rather than as zero: an upgrade decision must not conclude
   * "nobody is watching" from a wire that was never connected.
   */
  private watchers: (() => number) | undefined;
  /**
   * When a command or a person's input last touched the page.
   *
   * `null` until something does. The number itself is never interpreted here —
   * it goes out on `/v1/status` and the INSPECTOR decides what counts as
   * quiet, so changing that threshold does not need a daemon deploy (which is
   * the very thing this whole compatibility mechanism exists to avoid).
   */
  private lastActivityAt: number | null = null;

  constructor(deps: BrowserdHandlerDeps) {
    this.queue = deps.queue;
    this.driver = deps.driver;
    this.bootId = deps.bootId;
    this.token = deps.token;
    this.lease = deps.lease ?? new HandoffLease();
    // MERGED HERE, not at a call site. These describe what this daemon's CODE
    // can do, which is not something an assembler should be able to forget to
    // announce: the hosted `main.ts`, the local in-process session and a test
    // stack all construct this handler, and a capability missing from one of
    // them reads to the server as "fall back to the old path" on an engine
    // that supports the new one.
    this.features = [
      ...new Set([...(deps.features ?? []), ...BROWSERD_WEBMCP_FEATURES]),
    ];
    this.bundleHash = deps.bundleHash;
    this.contextMode = deps.contextMode;
    this.startedBy = deps.startedBy ?? "inspector";
    this.setVideoTier = deps.setVideoTier;
    this.recorder = deps.recorder;
  }

  /**
   * What is open and which tab is on screen, for a stream's heartbeat.
   *
   * `undefined` from a driver that has no concept of tabs, which the pane
   * reads as "this engine cannot tell you" rather than as "no tabs".
   */
  tabsSnapshot():
    { active?: string; list?: Array<{ id: string; url: string }> } | undefined {
    return this.driver.tabsSnapshot?.();
  }

  /**
   * The driven tab's page-tool set as a CHANGE SIGNAL, for a heartbeat.
   *
   * A cache read: it touches no page, which is the property that makes it safe
   * on a beat that fires several times a second. `undefined` from a driver with
   * no WebMCP, which the pane reads as "this engine cannot tell you" rather
   * than as "no tools".
   */
  webmcpSnapshot(tabId?: string): WebMcpToolsRevision | undefined {
    return this.driver.webmcpToolsSnapshot?.(tabId);
  }

  /** Let the stream host report itself on `/v1/status`. See `watchers`. */
  attachFrameCounters(watchers: () => number): void {
    this.watchers = watchers;
  }

  /**
   * The gate every route but `/healthz` sits behind: `undefined` to proceed, or
   * the refusal to write back.
   *
   * Extracted so the STREAMING route can share it. That route cannot go through
   * `handle` — its response is a chunked body, not a `DaemonResponse` — and a
   * second copy of an auth check is how one of them quietly stops matching the
   * other. Order matters and is preserved: an unauthenticated request carrying
   * an Origin gets 401, not 403, so a caller learns nothing about the second
   * check from failing the first.
   */
  authorize(req: DaemonRequest): DaemonResponse | undefined {
    // No `WWW-Authenticate` (browserd is not an OAuth resource server) and no
    // body — a 401 says nothing about why.
    if (!constantTimeEquals(presentedBearer(req.authorization), this.token)) {
      return { status: 401 };
    }
    // DNS-rebinding defence: every legitimate caller is server-side and sends no
    // Origin, so any Origin at all is rejected.
    if (req.origin !== undefined) {
      return { status: 403, body: { error: "cross_origin_forbidden" } };
    }
    return undefined;
  }

  async handle(req: DaemonRequest): Promise<DaemonResponse> {
    // `/healthz` is unauthenticated liveness and carries NO secrets — not the
    // token, not the bootId. The supervisor polls it to decide kill/relaunch on
    // wake (M0 recovery posture), so browser-down is a 503, not a thrown error.
    if (req.path === "/healthz") {
      if (req.method !== "GET" && req.method !== "HEAD") {
        return { status: 405, headers: { allow: "GET, HEAD" } };
      }
      const health = await this.driver.health();
      return health.ok
        ? { status: 200, body: { ok: true } }
        : { status: 503, body: { ok: false, detail: health.detail } };
    }

    const refusal = this.authorize(req);
    if (refusal) return refusal;

    if (req.path === "/v1/commands") {
      if (req.method !== "POST") {
        return { status: 405, headers: { allow: "POST" } };
      }
      return this.handleCommand(req);
    }

    // Authenticated status: liveness PLUS boot identity, in one probe. This is
    // what the durable-session reuse path polls — presenting the stored bearer
    // verifies the credential at the same time (a 401 means the row describes
    // a previous boot's secret), and `bootId` lets the caller distinguish "the
    // same daemon I recorded" from "something else is listening on that port".
    // `/healthz` above deliberately stays secret-free; this endpoint is the
    // authenticated counterpart.
    if (req.path === "/v1/status") {
      if (req.method !== "GET") {
        return { status: 405, headers: { allow: "GET" } };
      }
      const health = await this.driver.health();
      // The compatibility fields ride on BOTH answers. An unhealthy daemon is
      // still a daemon of a particular protocol, and the caller's next decision
      // — reuse, upgrade when idle, or relaunch now — needs the number whether
      // or not Chromium is currently answering.
      const identity = {
        bootId: this.bootId,
        protocolVersion: BROWSERD_PROTOCOL_VERSION,
        features: this.features,
        startedBy: this.startedBy,
        ...(this.bundleHash ? { bundleHash: this.bundleHash } : {}),
        ...(this.contextMode ? { contextMode: this.contextMode } : {}),
        // What "nobody is using this browser" is made of. Reported as FACTS,
        // never as a verdict: the caller applies its own quiet threshold, so
        // changing that threshold does not need a daemon deploy.
        lease: this.lease.state().state,
        ...(this.watchers ? { watchers: this.watchers() } : {}),
        ...(this.lastActivityAt === null
          ? {}
          : { msSinceActivity: Math.max(0, Date.now() - this.lastActivityAt) }),
      };
      return health.ok
        ? { status: 200, body: { ok: true, ...identity } }
        : {
            status: 503,
            body: { ok: false, detail: health.detail, ...identity },
          };
    }

    // The human-handoff lease: acquire / heartbeat / resume, plus a plain read.
    // Never gated by the lease itself — the whole point is that a person can
    // take and hand back control while model commands are blocked.
    if (req.path === "/v1/lease") {
      if (req.method !== "POST" && req.method !== "GET") {
        return { status: 405, headers: { allow: "GET, POST" } };
      }
      return this.handleLease(req);
    }

    // The quality tier a watcher asked for.
    //
    // NOT a lease-gated path: it changes how the picture is ENCODED, not what
    // it shows, and a person watching over somebody else's shoulder on a bad
    // link needs to be able to turn the bitrate down. Last writer wins across
    // the (at most four) subscribers, which is the honest shape of one shared
    // encoder — a per-subscriber tier would need a per-subscriber encoder.
    if (req.path === "/v1/policy") {
      if (req.method !== "POST") {
        return { status: 405, headers: { allow: "POST" } };
      }
      return this.handlePolicy(req);
    }

    // Recording control.
    //
    // NOT lease-gated, for the same reason `/v1/policy` is not: it governs
    // whether the run leaves evidence behind, not what anything observes, and
    // a person taking control mid-run must not end the recording of the run
    // they took it during. Nor is it a `BrowserAction`: a recording outlives
    // lease handoffs and must never enter the at-most-once command queue,
    // where a retried `stop` would be answered from a cache instead of
    // stopping anything.
    if (req.path === "/v1/record") {
      if (req.method !== "POST" && req.method !== "GET") {
        return { status: 405, headers: { allow: "GET, POST" } };
      }
      return this.handleRecord(req);
    }

    // Human input, which does NOT travel with the frames.
    //
    // One direction each: frames stream out over `/v1/frames`, input comes back
    // as ordinary requests. That split is the local engine's (its pane POSTs to
    // `/local-browser/input` while its socket only ever receives), and it is why
    // the frame transport can be a one-way body instead of a socket.
    if (req.path === "/v1/input") {
      if (req.method !== "POST") {
        return { status: 405, headers: { allow: "POST" } };
      }
      return this.handleInput(req);
    }

    return { status: 404 };
  }

  private handlePolicy(req: DaemonRequest): DaemonResponse {
    let parsed: unknown;
    try {
      parsed = JSON.parse(req.body || "{}");
    } catch {
      return {
        status: 400,
        body: { error: "invalid_json", bootId: this.bootId },
      };
    }
    // `JSON.parse("null")` is a successful parse of a non-object, and reading
    // a property off it throws — a 500 where this endpoint has a 400 to give.
    const tier =
      typeof parsed === "object" && parsed !== null
        ? (parsed as { tier?: unknown }).tier
        : undefined;
    if (tier !== "auto" && tier !== "sharp" && tier !== "saver") {
      return {
        status: 400,
        body: { error: "invalid_tier", bootId: this.bootId },
      };
    }
    // A box with no encoder answers 200 and does nothing: the caller's picture
    // is a JPEG, whose quality this endpoint does not govern, and reporting a
    // failure would send a pane looking for a problem it does not have.
    this.setVideoTier?.(tier);
    return { status: 200, body: { ok: true, tier, bootId: this.bootId } };
  }

  /**
   * Start or stop a recording.
   *
   * EVERY argument is validated before any spawn. A recording id becomes a
   * filename and an fps becomes an x11grab rate: getting either wrong after
   * the process is running means a file in the wrong place or an encoder at a
   * rate the box cannot sustain, and neither is visible from the 200 that
   * would come back. `fps` and `id` are echoed on every answer — including the
   * refusals — so a caller never has to remember what it asked for to make
   * sense of what it got.
   */
  private async handleRecord(req: DaemonRequest): Promise<DaemonResponse> {
    if (req.method === "GET") {
      // The state, on a box with a recorder or without one. `active:false`
      // rather than a 503: "nothing is recording" is the honest answer either
      // way, and the caller learns it can record from `features`.
      const status = this.recorder?.status() ?? { active: false };
      return { status: 200, body: { ...status, bootId: this.bootId } };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(req.body || "{}");
    } catch {
      return {
        status: 400,
        body: { error: "invalid_json", bootId: this.bootId },
      };
    }
    if (typeof parsed !== "object" || parsed === null) {
      return {
        status: 400,
        body: { error: "invalid_record_action", bootId: this.bootId },
      };
    }
    const { action, id, fps } = parsed as {
      action?: unknown;
      id?: unknown;
      fps?: unknown;
    };
    if (action !== "start" && action !== "stop") {
      return {
        status: 400,
        body: { error: "invalid_record_action", bootId: this.bootId },
      };
    }

    if (action === "stop") {
      if (!this.recorder) {
        return {
          status: 503,
          body: { error: "record_unavailable", bootId: this.bootId },
        };
      }
      const result = await this.recorder.stop();
      // `null` means nothing was recording. 200, not 409: stopping a take that
      // has already ended is what a caller collecting evidence on a teardown
      // path does when the encoder hit its size cap five minutes ago, and it
      // needs an answer it can read rather than an error it must special-case.
      return {
        status: 200,
        body: { ok: true, recording: result, bootId: this.bootId },
      };
    }

    // `fps` FIRST, before the id, so a caller fixing one error at a time is
    // told about the rate it cannot have before the daemon starts caring what
    // the file is called.
    const resolvedFps = fps === undefined ? DEFAULT_RECORD_FPS : fps;
    if (
      typeof resolvedFps !== "number" ||
      !Number.isInteger(resolvedFps) ||
      resolvedFps < MIN_RECORD_FPS ||
      resolvedFps > MAX_RECORD_FPS
    ) {
      return {
        status: 400,
        body: { error: "invalid_fps", fps, bootId: this.bootId },
      };
    }
    if (typeof id !== "string" || !RECORD_ID_PATTERN.test(id)) {
      // It is a FILENAME. A `..` or a slash here is a path the caller chose,
      // and the daemon writes wherever it points.
      return {
        status: 400,
        body: { error: "invalid_record_id", id, bootId: this.bootId },
      };
    }
    if (!this.recorder) {
      return {
        status: 503,
        body: {
          error: "record_unavailable",
          id,
          fps: resolvedFps,
          bootId: this.bootId,
        },
      };
    }
    const started = this.recorder.start({ id, fps: resolvedFps });
    if (!started.ok) {
      return {
        status: started.error === "record_active" ? 409 : 503,
        body: {
          error: started.error,
          id,
          fps: resolvedFps,
          bootId: this.bootId,
        },
      };
    }
    return {
      status: 200,
      body: { ok: true, id, fps: resolvedFps, bootId: this.bootId },
    };
  }

  private async handleInput(req: DaemonRequest): Promise<DaemonResponse> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(req.body || "{}");
    } catch {
      return {
        status: 400,
        body: { error: "invalid_json", bootId: this.bootId },
      };
    }
    if (typeof parsed !== "object" || parsed === null) {
      return {
        status: 400,
        body: { error: "invalid_input", bootId: this.bootId },
      };
    }
    const { holder, tabId, events } = parsed as {
      holder?: unknown;
      tabId?: unknown;
      events?: unknown;
    };
    if (typeof holder !== "string" || holder.length === 0) {
      return {
        status: 400,
        body: { error: "holder_required", bootId: this.bootId },
      };
    }
    if (!Array.isArray(events)) {
      return {
        status: 400,
        body: { error: "invalid_input", bootId: this.bootId },
      };
    }
    // CAPPED HERE, not only at the inspector's edge. The daemon is reachable on
    // its own public host, so a cap that lives only in the caller is a cap an
    // attacker skips — and each event is a synchronous CDP round trip.
    if (events.length > MAX_INPUT_EVENTS) {
      return {
        status: 413,
        body: { error: "too_many_events", bootId: this.bootId },
      };
    }
    this.lastActivityAt = Date.now();
    const outcome = await this.dispatchInput({
      ...(typeof tabId === "string" ? { tabId } : {}),
      holder,
      events: events as ViewportInputEvent[],
    });
    if (outcome.ok)
      return { status: 200, body: { ok: true, bootId: this.bootId } };
    return {
      status: outcome.error === "unknown_tab" ? 404 : 423,
      body: { error: outcome.error, bootId: this.bootId },
    };
  }

  private async handleCommand(req: DaemonRequest): Promise<DaemonResponse> {
    let parsed: CommandRequestBody;
    try {
      parsed = JSON.parse(req.body) as CommandRequestBody;
    } catch {
      return {
        status: 400,
        body: { error: "invalid_json", bootId: this.bootId },
      };
    }
    if (!isValidCommand(parsed?.command)) {
      return {
        status: 400,
        body: { error: "invalid_command", bootId: this.bootId },
      };
    }
    // Recorded BEFORE the lease gate, on purpose. A command the lease refuses
    // is still evidence that somebody is trying to use this browser right now,
    // and an upgrade that relaunched the daemon between an agent's refusal and
    // its retry would be exactly as disruptive as one taken mid-turn.
    this.lastActivityAt = Date.now();

    // HANDOFF GATE. A person holds (or has parked) the browser, so nothing
    // model-driven runs and — just as importantly — nothing OBSERVES: this
    // refusal happens before the queue, before the driver, before any frame is
    // captured, so a password being typed right now cannot reach a trace.
    //
    // `manual` is the person's own command, the one thing that must still work
    // while they hold it — but only THEIRS. A `manual` command that names no
    // holder, or names someone else, is the bypass this gate exists to close:
    // without the check, anything able to reach the daemon could drive and
    // observe a browser someone is signing into by simply claiming the source.
    // And a `manual` command while the lease is FREE is refused too: with
    // nobody holding it the agent may be mid-turn, and two drivers on one page
    // is precisely what the lease is for. Take the lease first.
    const leaseState = this.lease.state();
    const refusal: LeaseRefusal | undefined = leaseRefusalFor(
      leaseState,
      parsed.command,
    );
    if (refusal) {
      return {
        status: 423,
        body: {
          error: refusal,
          ...(leaseState.state === "free"
            ? {}
            : {
                holder: leaseState.holder,
                holderKind: leaseState.holderKind,
              }),
          bootId: this.bootId,
        },
      };
    }

    // bootId staleness: a command the caller expected a DIFFERENT boot to run is
    // rejected before it reaches the queue. Never re-execute across a restart.
    if (
      parsed.expectedBootId !== undefined &&
      parsed.expectedBootId !== this.bootId
    ) {
      return {
        status: 409,
        body: { error: "command_unknown_boot", bootId: this.bootId },
      };
    }

    const outcome = await this.queue.submit(parsed.command);
    // AFTER the command ran, so the boost covers the repaint it caused rather
    // than the frame before it — the same placement `dispatchInput` uses, and
    // for the same reason. Awaited so a test can observe it, but it never
    // decides the response: a boost that cannot be applied is a slower
    // picture, not a failed command.
    await this.boostAfterMotion(parsed.command, outcome);
    return this.mapOutcome(outcome);
  }

  /**
   * Raise the frame rate for a moment after a command that moved the page.
   *
   * The seam is HERE rather than in the driver because this is where the
   * command's fate is known: a `navigate` the lease refused, or one the queue
   * de-duplicated, never touched the page, and boosting after it would spend a
   * box's cores on a picture nothing changed. It runs for every source —
   * a chat-driven scroll and a person's own `manual` command are the same
   * motion to whoever is watching.
   *
   * `viewportIfWatched` and never `viewport`: on a box where nobody has the
   * pane open there is no viewport, and building one here would attach a CDP
   * screencast and start encoding JPEGs for an audience of nobody — on the
   * same two cores the agent is using. A driver too old to answer the question
   * (or a fake that does not implement it) simply gets no boost.
   */
  private async boostAfterMotion(
    command: BrowserCommand,
    outcome: BrowserCommandOutcome,
  ): Promise<void> {
    if (!MOTION_ACTIONS.has(command.action.kind)) return;
    // NOTHING RAN, so nothing moved: `busy` was refused at the depth cap,
    // `expired` lost its result to eviction, `at_capacity` was never admitted.
    // Boosting after any of them spends 45 JPEG encodes on a picture that did
    // not change, on the cores the agent is using.
    if (outcome.status !== "ok") return;
    // A SUCCESSFUL RESULT, AND NOTHING ELSE — because a failed one is genuinely
    // ambiguous here and this is only a frame-rate hint.
    //
    // `ok: false` covers both "refused before touching the page"
    // (`out_of_viewport`, `unknown_ref`, a stale observation) and "ran, then
    // threw partway" (a click that landed before its follow-up timed out). The
    // driver cannot tell those apart either: its catch classifies by message
    // and snapshots the page either way, so `act_failed` arrives carrying a
    // fresh `stateToken` in BOTH cases. Nothing reaching this method
    // distinguishes them.
    //
    // Given that, the two mistakes are not equal. Boosting a refusal spends
    // 1.5s of 30fps encoding on a page that did not move, on the two cores the
    // agent is using; not boosting a partial act leaves a watcher at 10fps
    // through the settle of a command that failed anyway. The first is a real
    // cost on every refusal, the second a cosmetic one on a rarer path — so
    // the gate takes the side that never spends CPU on a still page.
    //
    // Making this exact would mean the DRIVER reporting whether it dispatched,
    // which is a change across every act path for a hint whose worst case is a
    // choppier second and a half. Named here rather than approximated with a
    // list of error codes, which is how this gate has been wrong twice.
    //
    // A duplicate resolved from the queue's cache still boosts: it reports the
    // original result and the queue does not say which of the two it was. That
    // is the honest limit of what is knowable here, and the cost is a second
    // boost over a repaint that did happen.
    if (!outcome.result.ok) return;
    try {
      const viewport = await this.driver.viewportIfWatched?.(command.tabId);
      viewport?.boost?.(ACTIVITY_BOOST_INTERVAL_MS, ACTIVITY_BOOST_WINDOW_MS);
    } catch {
      // A viewport whose page closed under it rejects here. The command
      // already succeeded and its result is already owed to the caller; a
      // frame-rate hint is never worth turning that into a 500.
    }
  }

  /**
   * Watch a tab.
   *
   * Not an HTTP route: frames are a stream, and the local engine's transport
   * is a function call rather than a socket. It lives on the handler anyway,
   * beside the command gate, because the daemon is where the lease is
   * ENFORCED — "any future path that reads the browser must go through the
   * daemon to inherit that" (the rollout doc's own words). A viewport that
   * subscribed straight to the driver would be exactly the reader that
   * bypasses it.
   *
   * While someone holds the browser, only THEY may watch: a second pane
   * showing a person's password field as they type it is the same leak as an
   * agent screenshotting it, and the lease is the only thing that knows whose
   * hands are on the page.
   */
  async subscribeFrames(args: {
    tabId?: string;
    holder?: string;
    listener: (frame: ViewportFrame) => void;
    /**
     * Called once if the subscription is revoked mid-stream because the lease
     * moved. The transport is expected to close the connection: a watcher who
     * has lost the right to watch should be told, not silently starved.
     */
    onRevoked?: (reason: LeaseRefusal) => void;
  }): Promise<
    | {
        ok: true;
        unsubscribe: () => void;
        /**
         * Re-ask the lease question out of band.
         *
         * Revoking on frame delivery covers a page that is painting. A STATIC
         * page paints nothing, so a watcher who lost the lease would sit on a
         * frozen picture indefinitely with no way to tell that apart from a
         * quiet page. The transport calls this on its own heartbeat.
         */
        revalidate: () => void;
        /**
         * Is the tab this subscription was made against still the live one?
         *
         * `TabViewport.dispose()` clears its listeners SILENTLY — no callback,
         * no terminal event — so a closed tab, a crashed renderer or a
         * `driver.close()` leaves a subscriber holding a subscription that will
         * simply never fire again. Over a socket that is indistinguishable from
         * a page nobody is touching. The transport asks on its heartbeat and
         * ends the stream when the answer turns false.
         */
        stillCurrent: () => Promise<boolean>;
        /** This viewport's own drop accounting; see below. */
        counters: () => ViewportCounters;
        noteTransportDrop: () => void;
        subscriberCount: () => number;
      }
    | { ok: false; error: string }
  > {
    const refusal = this.watcherRefusal(args.holder);
    if (refusal) return { ok: false, error: refusal };
    const viewport = await this.driver.viewport?.(args.tabId);
    if (!viewport) return { ok: false, error: "unknown_tab" };
    // Re-checked after the await: resolving the viewport can open a tab and
    // attach a CDP session, and a handoff during that is exactly the case this
    // whole method exists to refuse.
    const afterAwait = this.watcherRefusal(args.holder);
    if (afterAwait) return { ok: false, error: afterAwait };

    // ...and re-checked on EVERY frame. `watcherRefusal` at setup only says
    // who was allowed to watch when the socket opened; a pane that subscribed
    // while the lease was free would otherwise keep receiving frames for the
    // whole time somebody else is typing into the page. This is the only check
    // that tracks the lease rather than sampling it once.
    let live = true;
    let unsubscribe: (() => void) | undefined;
    const revoke = (reason: LeaseRefusal) => {
      if (!live) return;
      live = false;
      // May be called from inside `subscribe` itself, before the returned
      // function exists; the `live` flag holds the line until it does.
      unsubscribe?.();
      args.onRevoked?.(reason);
    };
    unsubscribe = viewport.subscribe((frame) => {
      if (!live) return;
      const lost = this.watcherRefusal(args.holder);
      if (lost) {
        revoke(lost);
        return;
      }
      args.listener(frame);
    });
    if (!live) unsubscribe();
    return {
      ok: true,
      unsubscribe: () => {
        live = false;
        unsubscribe?.();
      },
      revalidate: () => {
        if (!live) return;
        const lost = this.watcherRefusal(args.holder);
        if (lost) revoke(lost);
      },
      // Identity, not existence: `viewport(tabId)` re-creates a viewport for a
      // tab that was closed and reopened, so "something is there" would answer
      // true while this subscription pointed at a dead object.
      //
      // ANSWERS RATHER THAN THROWS, because the only caller is a heartbeat and
      // a heartbeat has nowhere to put an exception. `viewport()` throws on
      // ordinary paths — a closing context says "this browser is shutting
      // down", and the Electron engine refuses past its tab cap — and a
      // rejection escaping into that tick both stopped the tick (so the lease
      // went unchecked for the life of the stream) and, being unhandled, ended
      // the daemon process. "I could not confirm this is still your tab" is
      // false, and false is already the answer that ends the stream cleanly.
      stillCurrent: async () => {
        if (!live) return false;
        try {
          return (await this.driver.viewport?.(args.tabId)) === viewport;
        } catch {
          return false;
        }
      },
      /**
       * What this viewport has seen and thrown away, plus whose it is.
       *
       * Rides the heartbeat rather than a route of its own: the numbers are
       * only interesting to somebody already reading this stream, and a
       * separate endpoint would need its own auth, its own cadence and its own
       * way of naming which viewport it meant.
       */
      counters: () => viewport.counters(),
      /** A frame this viewport published that the transport could not take. */
      noteTransportDrop: () => viewport.noteTransportDrop(),
      subscriberCount: () => viewport.subscriberCount(),
    };
  }

  /**
   * The lease gate, without subscribing to a tab's frames.
   *
   * The VIDEO stream needs exactly this and nothing else: its pixels come from
   * the X display rather than from a tab's screencast, so `subscribeFrames`
   * would start a `Page.startScreencast` and a JPEG encoder that nobody reads —
   * on a box the agent is also using — purely to borrow the lease check.
   *
   * PER SUBSCRIBER, deliberately. One encoder serves every watcher, but who may
   * SEE it is asked of each of them separately: a person taking the browser
   * ends the other watchers' streams with their own `lease_held` while the
   * encoder keeps running for the holder's own pane. End reasons are about who
   * may look, not about who is encoding.
   */
  watchLease(args: {
    holder?: string;
    onRevoked?: (reason: LeaseRefusal) => void;
  }):
    | { ok: true; revalidate: () => void; release: () => void }
    | { ok: false; error: LeaseRefusal } {
    const refusal = this.watcherRefusal(args.holder);
    if (refusal) return { ok: false, error: refusal };
    let live = true;
    return {
      ok: true,
      revalidate: () => {
        if (!live) return;
        const lost = this.watcherRefusal(args.holder);
        if (!lost) return;
        live = false;
        args.onRevoked?.(lost);
      },
      release: () => {
        live = false;
      },
    };
  }

  /**
   * Forward a person's input.
   *
   * Requires the lease, and requires it to be THEIRS — this is the one path
   * that puts keystrokes into the page without a per-action approval, so the
   * question "who is typing" has to have an answer that is not "whoever
   * reached the endpoint".
   */
  async dispatchInput(args: {
    tabId?: string;
    holder: string;
    events: readonly ViewportInputEvent[];
  }): Promise<{ ok: true } | { ok: false; error: string }> {
    const stillTheirs = () =>
      leaseRefusalFor(this.lease.state(), {
        source: "manual",
        holder: args.holder,
      });
    const refusal = stillTheirs();
    if (refusal) return { ok: false, error: refusal };
    const viewport = await this.driver.viewport?.(args.tabId);
    if (!viewport) return { ok: false, error: "unknown_tab" };
    // Re-asked after the await and then before EVERY event: a batch is up to
    // 64 keystrokes and pointer moves, and a lease that expires or is handed
    // on midway through must not let the previous holder keep typing into
    // somebody else's page.
    const afterAwait = stillTheirs();
    if (afterAwait) return { ok: false, error: afterAwait };
    await viewport.dispatchInput(
      args.events,
      () => stillTheirs() === undefined,
      args.holder,
    );
    // AFTER the dispatch, so the boost covers the repaint it caused rather
    // than the frame before it — and only when there WAS a dispatch: an empty
    // batch changed nothing on the page, and raising the screencast to 30fps
    // for a second and a half over it is a box paying for nothing.
    if (args.events.length > 0) {
      viewport.boost?.(ACTIVITY_BOOST_INTERVAL_MS, ACTIVITY_BOOST_WINDOW_MS);
    }
    return { ok: true };
  }

  /** May this watcher see frames right now? */
  private watcherRefusal(holder: string | undefined): LeaseRefusal | undefined {
    const lease = this.lease.state();
    if (lease.state === "free") return undefined;
    return holder && holder === lease.holder
      ? undefined
      : lease.state === "held"
        ? "lease_held"
        : "lease_parked";
  }

  /**
   * Lease control. Every action names its `holder` so one person's lease
   * cannot be released by another tab that happens to know the endpoint.
   */
  private handleLease(req: DaemonRequest): DaemonResponse {
    if (req.method === "GET") {
      return { status: 200, body: this.leaseBody(this.lease.state()) };
    }
    let parsed: {
      action?: unknown;
      holder?: unknown;
      ttlMs?: unknown;
      kind?: unknown;
    };
    try {
      parsed = JSON.parse(req.body) as typeof parsed;
    } catch {
      return {
        status: 400,
        body: { error: "invalid_json", bootId: this.bootId },
      };
    }
    const holder = typeof parsed?.holder === "string" ? parsed.holder : "";
    if (!holder) {
      return {
        status: 400,
        body: { error: "holder_required", bootId: this.bootId },
      };
    }
    const ttlMs =
      typeof parsed?.ttlMs === "number" && Number.isFinite(parsed.ttlMs)
        ? parsed.ttlMs
        : undefined;
    // Anything but the exact string is a person: a mislabelled script would
    // make the resume note tell the model a human was here, and the note's
    // whole job is to say what actually touched the page.
    const kind: LeaseHolderKind =
      parsed?.kind === "script" ? "script" : "human";

    let state: LeaseState;
    switch (parsed?.action) {
      case "acquire":
        state = this.lease.acquire(holder, ttlMs, kind);
        break;
      case "heartbeat":
        state = this.lease.heartbeat(holder, ttlMs);
        break;
      case "resume":
      case "release":
        state = this.lease.resume(holder);
        break;
      default:
        return {
          status: 400,
          body: { error: "invalid_lease_action", bootId: this.bootId },
        };
    }
    // An acquire that did not take (someone else holds it) is a 409, not a
    // silent no-op: a UI that thinks it has the browser would show a person a
    // live view while the model kept driving.
    const took =
      parsed.action !== "acquire" ||
      (state.state === "held" && state.holder === holder);
    return {
      status: took ? 200 : 409,
      body: this.leaseBody(state),
    };
  }

  private leaseBody(state: LeaseState): Record<string, unknown> {
    return {
      lease: state,
      bootId: this.bootId,
    };
  }

  /** Map a queue outcome to an HTTP response. */
  private mapOutcome(outcome: BrowserCommandOutcome): DaemonResponse {
    switch (outcome.status) {
      case "ok":
        // A command the lease caught INSIDE the queue (at dequeue, or between
        // an act and its capture) comes back as an ok outcome carrying
        // `leaseBlocked`. Map it to the same 423 the gate returns: one refusal
        // whichever side of the queue the handoff happened on.
        if (outcome.result.leaseBlocked) {
          const lease = this.lease.state();
          // The ENVELOPE carries the bare code, because that is what the client
          // codec matches on: a `lease_parked: <prose>` forwarded whole reads
          // to it as an unknown refusal and gets reported as `held`, which is
          // the wrong word for "the browser is parked mid-handoff". The prose
          // is not lost — it rides along as `detail`.
          const code =
            parseBrowserdErrorCode(outcome.result.error) ?? "lease_held";
          return {
            status: 423,
            body: {
              error: code,
              ...(outcome.result.error && outcome.result.error !== code
                ? { detail: outcome.result.error }
                : {}),
              ...(lease.state === "free"
                ? {}
                : { holder: lease.holder, holderKind: lease.holderKind }),
              bootId: outcome.bootId,
            },
          };
        }
        // An `act` refused for a stale observation (L3) rides back as an OK
        // outcome carrying a `staleObservation` result; surface it as a 409 with
        // the fresh state so the caller re-decides.
        if (outcome.result.staleObservation) {
          return {
            status: 409,
            body: {
              error: "stale_observation",
              result: outcome.result,
              bootId: outcome.bootId,
            },
          };
        }
        return {
          status: 200,
          body: {
            status: "ok",
            result: outcome.result,
            bootId: outcome.bootId,
          },
        };
      case "busy":
        return {
          status: 429,
          body: { status: "busy", bootId: outcome.bootId },
        };
      case "expired":
        return {
          status: 409,
          body: { error: "command_expired", bootId: outcome.bootId },
        };
      case "at_capacity":
        return {
          status: 503,
          body: { error: "daemon_at_capacity", bootId: outcome.bootId },
        };
    }
  }
}

/** Minimal structural validation — the queue trusts the envelope's shape. */
function isValidCommand(value: unknown): value is BrowserCommand {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<BrowserCommand>;
  return (
    typeof candidate.commandId === "string" &&
    candidate.commandId.length > 0 &&
    typeof candidate.source === "string" &&
    typeof candidate.action === "object" &&
    candidate.action !== null &&
    (candidate.tabId === undefined || typeof candidate.tabId === "string") &&
    (candidate.holder === undefined || typeof candidate.holder === "string")
  );
}
