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
  BROWSERD_OBSERVATION_VIEWPORT,
  BROWSERD_PROTOCOL_VERSION,
  parseBrowserdErrorCode,
  type BrowserCommand,
  type BrowserCommandOutcome,
} from "../protocol";
import type {
  BrowserLedgerActor,
  BrowserLedgerRow,
  CommandLedger,
} from "./command-ledger";
import type { CommandQueue } from "./command-queue";
import type { BrowserDriver } from "./browser-driver";
import type {
  ViewportCounters,
  ViewportFrame,
  ViewportInputEvent,
} from "./viewport";
import { constantTimeEquals, presentedBearer } from "./auth";
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
 * The frame interval a person's input buys, and for how long.
 *
 * 33ms is 30fps — the ceiling the transports can actually carry — and 1.5s is
 * long enough to cover the echo of a gesture and the settle after it without
 * keeping a page at full rate because somebody clicked once.
 */
const INPUT_BOOST_INTERVAL_MS = 33;
const INPUT_BOOST_WINDOW_MS = 1_500;

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
  driver: Pick<BrowserDriver, "health" | "viewport" | "tabsSnapshot">;
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
   * The command ledger, written HERE and nowhere else.
   *
   * At the command entry rather than around the executor because this is the
   * only place that sees every disposition: the lease refusal below, the
   * bootId rejection below that, and the queue's own `busy`/`expired`/
   * `at_capacity` outcomes never reach an executor at all. A ledger that wrapped
   * `CommandExecutor` would record exactly the commands that RAN and silently
   * lose every command that was refused — and "the agent tried to drive while
   * a person held the browser" is the row the whole trace exists for.
   *
   * Optional: a daemon built without one still works, it just remembers
   * nothing. Nothing in the command path may depend on its presence.
   */
  ledger?: CommandLedger;
  /**
   * May the ledger keep `type` values verbatim for this browser?
   *
   * A property of the SESSION, decided by the door (ephemeral profiles only),
   * not of any one command — so it is configured once here rather than
   * travelling on an envelope a caller controls.
   */
  captureTypedText?: boolean;
}

/**
 * The actor a command with no stamped identity is recorded against.
 *
 * Not "unknown" and not omitted: a row has to say something, and the honest
 * something is that this command reached the daemon through a path that does
 * not attribute — which is a fact about our own plumbing, worth seeing in a
 * trace rather than smoothing over.
 */
const UNATTRIBUTED_ACTOR: BrowserLedgerActor = {
  kind: "inspector",
  id: "unattributed",
};

export class BrowserdRequestHandler {
  private readonly queue: Pick<CommandQueue, "submit">;
  private readonly driver: Pick<
    BrowserDriver,
    "health" | "viewport" | "tabsSnapshot"
  >;
  private readonly bootId: string;
  private readonly token: string;
  private readonly lease: HandoffLease;
  private readonly features: readonly string[];
  private readonly bundleHash: string | undefined;
  private readonly contextMode: "persistent" | "ephemeral" | undefined;
  private readonly startedBy: "prelaunch" | "inspector";
  private readonly setVideoTier: BrowserdHandlerDeps["setVideoTier"];
  private readonly ledger: CommandLedger | undefined;
  private readonly captureTypedText: boolean;
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
    this.features = deps.features ?? [];
    this.bundleHash = deps.bundleHash;
    this.contextMode = deps.contextMode;
    this.startedBy = deps.startedBy ?? "inspector";
    this.setVideoTier = deps.setVideoTier;
    this.ledger = deps.ledger;
    this.captureTypedText = deps.captureTypedText === true;
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

    // The ledger, read forward from a cursor.
    //
    // NOT lease-gated, and deliberately: the rows carry no page content — the
    // artifacts live behind `/v1/artifact` and are never captured for a command
    // the lease refused — and a person who has taken the browser should still be
    // able to see what the agent was doing before they took it. The one thing
    // this endpoint could leak is a URL, which is already stripped of its query.
    if (req.path === "/v1/trace") {
      if (req.method !== "GET") {
        return { status: 405, headers: { allow: "GET" } };
      }
      return this.handleTrace(req);
    }

    // One artifact payload, by the id a row names.
    //
    // Separate from the trace read because a screenshot is a hundred kilobytes
    // and a trace page is a hundred rows: inlining them would make the common
    // read — "what has happened lately" — the expensive one.
    if (req.path === "/v1/artifact") {
      if (req.method !== "GET" && req.method !== "DELETE") {
        return { status: 405, headers: { allow: "GET, DELETE" } };
      }
      return this.handleArtifact(req);
    }

    return { status: 404 };
  }

  private handleTrace(req: DaemonRequest): DaemonResponse {
    if (!this.ledger) {
      // A daemon built without a ledger says so, rather than answering with an
      // empty list — "nothing happened" and "I am not recording" are different
      // answers and a caller acts differently on each.
      return {
        status: 501,
        body: { error: "ledger_unavailable", bootId: this.bootId },
      };
    }
    const query = req.query;
    const afterSeq = readNumber(query?.get("afterSeq"));
    const limit = readNumber(query?.get("limit"));
    const commandId = query?.get("commandId") ?? undefined;
    const { entries, headSeq } = this.ledger.read({
      ...(afterSeq === undefined ? {} : { afterSeq }),
      ...(limit === undefined ? {} : { limit }),
      ...(commandId ? { commandId } : {}),
    });
    return {
      status: 200,
      body: { entries, headSeq, bootId: this.bootId },
    };
  }

  private handleArtifact(req: DaemonRequest): DaemonResponse {
    if (!this.ledger) {
      return {
        status: 501,
        body: { error: "ledger_unavailable", bootId: this.bootId },
      };
    }
    const id = req.query?.get("id") ?? "";
    if (!id) {
      return {
        status: 400,
        body: { error: "artifact_id_required", bootId: this.bootId },
      };
    }
    if (req.method === "DELETE") {
      // The mirror saying "I have this on disk now". Idempotent: releasing an
      // id twice, or one that already aged out, is a success — the postcondition
      // the caller wants (the daemon is not holding this payload) is true either
      // way.
      this.ledger.releaseArtifact(id);
      return { status: 200, body: { released: true, bootId: this.bootId } };
    }
    const artifact = this.ledger.artifact(id);
    if (!artifact) {
      // 410 rather than 404: this id was real and its payload has aged out,
      // which is a different thing from an id that never existed and points the
      // caller at the row's `evicted` marker rather than at a typo.
      return {
        status: 410,
        body: { error: "artifact_evicted", id, bootId: this.bootId },
      };
    }
    return { status: 200, body: { artifact, bootId: this.bootId } };
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
    const startedAt = Date.now();
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
      // Recorded, and recorded WITHOUT a page: the gate above captured nothing,
      // so there is nothing to attach and nothing to leak. The row is the point
      // — an agent that got refused while somebody was signing in is exactly
      // what a person reading this trace is trying to find out.
      this.recordRow(parsed.command, startedAt, {
        outcome: "refused",
        errorCode: refusal,
      });
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
      // UNKNOWN, not refused. This boot did not run it — but the boot the
      // caller was talking to may well have, and the whole reason we refuse
      // rather than re-run is that its fate is unknowable. Recording that as
      // "refused" would tell a caller it is safe to retry a form submission
      // that may already have gone through.
      this.recordRow(parsed.command, startedAt, {
        outcome: "unknown",
        errorCode: "command_unknown_boot",
      });
      return {
        status: 409,
        body: { error: "command_unknown_boot", bootId: this.bootId },
      };
    }

    const outcome = await this.queue.submit(parsed.command);
    const response = this.mapOutcome(outcome);
    this.recordOutcome(parsed.command, outcome, startedAt);
    return response;
  }

  /**
   * One command, one row — written from the one place that sees them all.
   *
   * The mapping from queue outcome to ledger outcome is the interesting part,
   * and it turns on a single distinction the rest of this file is careful
   * about: `refused` means NOTHING RAN, `unknown` means WE CANNOT SAY. They are
   * never collapsed. A caller that reads "refused" and retries is correct; a
   * caller that reads "unknown" and retries may double-submit a payment, which
   * is why `expired` — a result the queue evicted and therefore may not re-run —
   * is `unknown` rather than the more comfortable-looking `refused`.
   */
  private recordOutcome(
    command: BrowserCommand,
    outcome: BrowserCommandOutcome,
    startedAt: number,
  ): void {
    if (!this.ledger) return;
    if (outcome.status !== "ok") {
      this.recordRow(command, startedAt, {
        // `busy` and `at_capacity` are back-pressure: the queue never admitted
        // the command, so nothing ran and a retry is safe. `expired` is the
        // opposite — it ran once, its result is gone, and re-running it is the
        // thing the tombstone exists to prevent.
        outcome: outcome.status === "expired" ? "unknown" : "refused",
        errorCode:
          outcome.status === "expired"
            ? "command_expired"
            : outcome.status === "busy"
              ? "busy"
              : "daemon_at_capacity",
      });
      return;
    }
    const { result } = outcome;
    // A handoff that landed INSIDE the queue: the command was admitted, then a
    // person took the browser before it could be observed. Same row as the gate
    // refusal above it, because it is the same event from the other side.
    if (result.leaseBlocked) {
      this.recordRow(command, startedAt, {
        outcome: "refused",
        errorCode: parseBrowserdErrorCode(result.error) ?? "lease_held",
      });
      return;
    }
    if (result.staleObservation) {
      // Nothing ran: the page moved under the caller and the act was refused so
      // it can re-decide. The FRESH observation the refusal carries is recorded
      // — it was legitimately captured, and it is what the caller will act on.
      this.recordRow(command, startedAt, {
        outcome: "refused",
        errorCode: "stale_observation",
        result,
        capturePage: true,
      });
      return;
    }
    // A duplicate that resolved to a retained result adds NO row: the execution
    // it resolved to already has one. The exception is a retry whose original
    // row has aged out of the ring, which is recorded as a duplicate rather
    // than as a second click.
    if (outcome.deduped) {
      const known = this.ledger.read({ commandId: command.commandId, limit: 1 });
      if (known.entries.length > 0) return;
      this.recordRow(command, startedAt, {
        outcome: "executed",
        deduped: true,
        result,
        capturePage: true,
      });
      return;
    }
    this.recordRow(command, startedAt, {
      outcome: "executed",
      result,
      capturePage: true,
    });
  }

  /** The single call site that turns a disposition into a row. */
  private recordRow(
    command: BrowserCommand,
    startedAt: number,
    what: {
      outcome: BrowserLedgerRow["outcome"];
      errorCode?: string;
      deduped?: boolean;
      result?: { ok: boolean; error?: string; output?: unknown; stateToken?: unknown; cursors?: { console: number; errors: number } };
      /**
       * Artifacts are kept only for a command that actually looked at the page.
       * A refusal has no output by construction — the lease gate runs before
       * anything captures — and a ledger that stored one anyway would be the
       * leak the gate exists to prevent.
       */
      capturePage?: boolean;
    },
  ): void {
    if (!this.ledger) return;
    const result = what.result;
    this.ledger.record({
      command,
      actor: command.actor ?? UNATTRIBUTED_ACTOR,
      ...(command.sessionId ? { sessionId: command.sessionId } : {}),
      ...(command.correlation ? { correlation: command.correlation } : {}),
      ts: startedAt,
      durationMs: Math.max(0, Date.now() - startedAt),
      outcome: what.outcome,
      ...(result ? { ok: result.ok } : {}),
      ...(what.errorCode
        ? { errorCode: what.errorCode }
        : result && !result.ok && parseBrowserdErrorCode(result.error)
          ? { errorCode: parseBrowserdErrorCode(result.error) as string }
          : {}),
      ...(what.deduped ? { deduped: true } : {}),
      ...(what.capturePage && result ? { output: result.output } : {}),
      ...(what.capturePage && result?.stateToken
        ? { stateToken: result.stateToken as never }
        : {}),
      ...(what.capturePage ? { viewport: { ...BROWSERD_OBSERVATION_VIEWPORT } } : {}),
      ...(result?.cursors ? { cursors: result.cursors } : {}),
      ...(what.capturePage ? { capturePage: true } : {}),
      ...(this.captureTypedText ? { captureTypedText: true } : {}),
    });
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
      viewport.boost?.(INPUT_BOOST_INTERVAL_MS, INPUT_BOOST_WINDOW_MS);
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

function readNumber(value: string | null | undefined): number | undefined {
  if (value === null || value === undefined || value === "") return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
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
