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
  parseBrowserdErrorCode,
  type BrowserCommand,
  type BrowserCommandOutcome,
} from "../protocol";
import type { CommandQueue } from "./command-queue";
import type { BrowserDriver } from "./browser-driver";
import type { ViewportFrame, ViewportInputEvent } from "./viewport";
import { constantTimeEquals, presentedBearer } from "./auth";
import {
  HandoffLease,
  leaseRefusalFor,
  type LeaseHolderKind,
  type LeaseRefusal,
  type LeaseState,
} from "./lease";

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
  driver: Pick<BrowserDriver, "health" | "viewport">;
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
}

export class BrowserdRequestHandler {
  private readonly queue: Pick<CommandQueue, "submit">;
  private readonly driver: Pick<BrowserDriver, "health" | "viewport">;
  private readonly bootId: string;
  private readonly token: string;
  private readonly lease: HandoffLease;

  constructor(deps: BrowserdHandlerDeps) {
    this.queue = deps.queue;
    this.driver = deps.driver;
    this.bootId = deps.bootId;
    this.token = deps.token;
    this.lease = deps.lease ?? new HandoffLease();
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

    // Everything else is authenticated. No `WWW-Authenticate` (browserd is not
    // an OAuth resource server) and no body — a 401 says nothing about why.
    if (!constantTimeEquals(presentedBearer(req.authorization), this.token)) {
      return { status: 401 };
    }

    // DNS-rebinding defence: every legitimate caller is server-side and sends no
    // Origin, so any Origin at all is rejected.
    if (req.origin !== undefined) {
      return { status: 403, body: { error: "cross_origin_forbidden" } };
    }

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
      return health.ok
        ? { status: 200, body: { ok: true, bootId: this.bootId } }
        : {
            status: 503,
            body: { ok: false, detail: health.detail, bootId: this.bootId },
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

    return { status: 404 };
  }

  private async handleCommand(req: DaemonRequest): Promise<DaemonResponse> {
    let parsed: CommandRequestBody;
    try {
      parsed = JSON.parse(req.body) as CommandRequestBody;
    } catch {
      return { status: 400, body: { error: "invalid_json", bootId: this.bootId } };
    }
    if (!isValidCommand(parsed?.command)) {
      return {
        status: 400,
        body: { error: "invalid_command", bootId: this.bootId },
      };
    }

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
    return this.mapOutcome(outcome);
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
    { ok: true; unsubscribe: () => void } | { ok: false; error: string }
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
    await viewport.dispatchInput(args.events, () => stillTheirs() === undefined);
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
      return { status: 400, body: { error: "invalid_json", bootId: this.bootId } };
    }
    const holder = typeof parsed?.holder === "string" ? parsed.holder : "";
    if (!holder) {
      return { status: 400, body: { error: "holder_required", bootId: this.bootId } };
    }
    const ttlMs =
      typeof parsed?.ttlMs === "number" && Number.isFinite(parsed.ttlMs)
        ? parsed.ttlMs
        : undefined;
    // Anything but the exact string is a person: a mislabelled script would
    // make the resume note tell the model a human was here, and the note's
    // whole job is to say what actually touched the page.
    const kind: LeaseHolderKind = parsed?.kind === "script" ? "script" : "human";

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
          body: { status: "ok", result: outcome.result, bootId: outcome.bootId },
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
