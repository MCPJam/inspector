/**
 * Lifecycle for WebMCP Inspector sessions: capacity, expiry, teardown.
 *
 * The shape is `services/widget-render-session.ts`, which already solved this
 * for headless widget renders: reserve a slot synchronously BEFORE the async
 * launch so a burst of concurrent starts cannot each pass a point-in-time
 * check; count still-disposing browsers against the cap because `dispose()` is
 * async and the Chromium process outlives the map entry; refuse new work once
 * a permanent shutdown has begun.
 *
 * Two differences from that template, both because this browser is one a person
 * is looking at:
 *   - The idle clock is refreshed by the BROWSER's own activity as well as by
 *     API calls, so a session someone is using through its own window is not
 *     reaped while the inspector tab sits closed.
 *   - There is an absolute lifetime as well as an idle timeout. A page left
 *     open overnight, quietly firing timers, would otherwise never look idle.
 */
import { randomUUID } from "node:crypto";
import type {
  WebMcpSessionPublic,
  WebMcpToolDescriptor,
} from "@/shared/webmcp-inspector-protocol";
import {
  playwrightWebMcpProvider,
  type PlaywrightWebMcpProvider,
} from "./playwright-provider";
import {
  WebMcpUnsupportedError,
  type WebMcpBrowserProvider,
  type WebMcpViewportMode,
} from "./provider";
import { WebMcpSessionRuntime } from "./session-runtime";
import type { WebMcpEventListener } from "./stream-hub";

export class WebMcpSessionCapacityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WebMcpSessionCapacityError";
  }
}
export class WebMcpSessionNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WebMcpSessionNotFoundError";
  }
}
export class WebMcpSessionUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WebMcpSessionUnavailableError";
  }
}

export interface WebMcpSessionRegistryOptions {
  /** Max concurrent browsers. Default 2 — each one is a real window. */
  maxSessions?: number;
  /** Max concurrent HOSTED sessions; these are handles, not windows. */
  maxHostedSessions?: number;
  /** Idle TTL, refreshed by API calls and by browser activity. Default 10 min. */
  idleTimeoutMs?: number;
  /** Hard ceiling regardless of activity. Default 60 min. */
  maxLifetimeMs?: number;
  /** Sweep interval; <= 0 disables the timer (tests sweep by hand). Default 30s. */
  sweepIntervalMs?: number;
  now?: () => number;
}

/**
 * How to describe letting go of a session.
 *
 * One helper so the sweep and the shutdown path cannot drift: a hosted
 * session's browser outlives this process, so dropping our handle is
 * `detached`, and only a local session's browser actually closes.
 */
function closeReasonFor(sessionId: string): "closed" | "detached" {
  return kindOf(sessionId) === "hosted" ? "detached" : "closed";
}

/**
 * The two things this registry holds, which are NOT the same resource.
 *
 * A local session is a Chromium window on this machine; a hosted one is a
 * handle to a browser running on a member's own desktop. They have their own
 * ceilings for that reason, and therefore their own tallies: counting them
 * together made each ceiling apply to the sum, so two hosted handles — well
 * inside a limit of 50 — filled the local limit of 2 and refused to open a
 * window. Both kinds live in one process whenever the local inspector runs a
 * hosted browser, which is a supported thing to do.
 */
type SessionKind = "hosted" | "local";

function kindOf(sessionId: string | undefined): SessionKind {
  return sessionId?.startsWith("hosted:") ? "hosted" : "local";
}

const DEFAULT_MAX_SESSIONS = 2;
/**
 * The cap for HOSTED sessions, which are a different thing being counted.
 *
 * `DEFAULT_MAX_SESSIONS` is 2 because each local session is a real Chromium
 * window on somebody's laptop. A hosted session is a handle to a browser
 * running on the member's own machine, one per (project, owner) desktop; this
 * process holds a poll timer and a tool list, and the actual resource is
 * capped by the desktop reserve, not by us. Two would mean the third member to
 * open the inspector on a replica gets told the server is full.
 */
const DEFAULT_MAX_HOSTED_SESSIONS = 50;

function hostedMaxSessions(): number {
  const raw = Number(process.env.MCPJAM_WEBMCP_HOSTED_MAX_SESSIONS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_MAX_HOSTED_SESSIONS;
}

// The `hosted:<projectId>:<computerId>` id format lives in the shared protocol
// — the client reads it too — and is re-exported here because every server
// caller already reaches for the registry to get it.
export {
  hostedSessionId,
  parseHostedSessionId,
} from "@/shared/webmcp-inspector-protocol";
const DEFAULT_IDLE_TIMEOUT_MS = 10 * 60_000;
const DEFAULT_MAX_LIFETIME_MS = 60 * 60_000;
const DEFAULT_SWEEP_INTERVAL_MS = 30_000;

/**
 * A held capacity slot. The id is registry-issued and checked against a live
 * set, so a forged `{ active: true }` cannot drive the counter negative.
 */
export interface WebMcpSessionReservation {
  readonly id: string;
  active: boolean;
}

export class WebMcpSessionRegistry {
  private readonly sessions = new Map<string, WebMcpSessionRuntime>();
  /** sessionId → live event-stream subscribers on THIS replica. */
  private readonly subscriberCounts = new Map<string, number>();
  private readonly maxSessions: number;
  private readonly maxHostedSessions: number;
  private readonly idleTimeoutMs: number;
  private readonly maxLifetimeMs: number;
  private readonly sweepIntervalMs: number;
  private readonly now: () => number;
  private sweepTimer: ReturnType<typeof setInterval> | null = null;
  /** Removed from the map, but their Chromium is still going away. */
  private readonly disposingCount: Record<SessionKind, number> = {
    hosted: 0,
    local: 0,
  };
  private readonly reservedCount: Record<SessionKind, number> = {
    hosted: 0,
    local: 0,
  };
  /** Reservation id → the kind it is holding a slot for, so release can undo it. */
  private readonly reservationKinds = new Map<string, SessionKind>();
  private shuttingDown = false;

  constructor(options: WebMcpSessionRegistryOptions = {}) {
    this.maxSessions = options.maxSessions ?? DEFAULT_MAX_SESSIONS;
    this.maxHostedSessions = options.maxHostedSessions ?? hostedMaxSessions();
    this.idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
    this.maxLifetimeMs = options.maxLifetimeMs ?? DEFAULT_MAX_LIFETIME_MS;
    this.sweepIntervalMs = options.sweepIntervalMs ?? DEFAULT_SWEEP_INTERVAL_MS;
    this.now = options.now ?? Date.now;
  }

  size(): number {
    return this.sessions.size;
  }

  /**
   * The registry's clock. Sessions must read time from here rather than calling
   * `Date.now()` themselves: the registry compares a session's deadlines
   * against this, and two clocks would mean a session whose absolute lifetime
   * is measured on a different timeline than the sweep that enforces it.
   */
  clock(): number {
    return this.now();
  }

  getIdleTimeoutMs(): number {
    return this.idleTimeoutMs;
  }

  /** Live, dying and reserved slots OF ONE KIND — never of both together. */
  private activeCount(kind: SessionKind): number {
    let live = 0;
    for (const sessionId of this.sessions.keys()) {
      if (kindOf(sessionId) === kind) live += 1;
    }
    return live + this.disposingCount[kind] + this.reservedCount[kind];
  }

  /** Which ceiling applies: local windows are scarce, hosted handles are not. */
  private ceilingFor(kind: SessionKind): number {
    return kind === "hosted" ? this.maxHostedSessions : this.maxSessions;
  }

  reserve(sessionId?: string): WebMcpSessionReservation {
    if (this.shuttingDown) {
      throw new WebMcpSessionUnavailableError(
        "The WebMCP Inspector is shutting down.",
      );
    }
    this.sweepExpired();
    const kind = kindOf(sessionId);
    if (this.activeCount(kind) >= this.ceilingFor(kind)) {
      throw new WebMcpSessionCapacityError(
        `Only ${this.ceilingFor(kind)} WebMCP browser sessions can run at once. Close one and try again.`,
      );
    }
    const reservation: WebMcpSessionReservation = {
      id: randomUUID(),
      active: true,
    };
    this.reservationKinds.set(reservation.id, kind);
    this.reservedCount[kind] += 1;
    this.ensureSweeping();
    return reservation;
  }

  release(reservation: WebMcpSessionReservation): void {
    const kind = this.reservationKinds.get(reservation.id);
    if (kind === undefined) return;
    this.reservationKinds.delete(reservation.id);
    reservation.active = false;
    this.reservedCount[kind] -= 1;
    this.stopSweepingIfIdle();
  }

  register(
    runtime: WebMcpSessionRuntime,
    reservation?: WebMcpSessionReservation,
  ): WebMcpSessionPublic {
    if (this.shuttingDown) {
      if (reservation) this.release(reservation);
      throw new WebMcpSessionUnavailableError(
        "The WebMCP Inspector is shutting down.",
      );
    }
    if (reservation) {
      this.release(reservation);
    } else if (
      this.activeCount(kindOf(runtime.sessionId)) >=
      this.ceilingFor(kindOf(runtime.sessionId))
    ) {
      throw new WebMcpSessionCapacityError(
        `Only ${this.ceilingFor(kindOf(runtime.sessionId))} WebMCP browser sessions can run at once.`,
      );
    }
    // Close whatever held this id first. Ids used to be random per runtime, so
    // a collision was impossible and overwriting was harmless; a hosted id is
    // DERIVED from the computer, so two requests racing to re-hydrate the same
    // session collide by design. Dropping the loser without closing it leaks
    // its poll timer, which keeps sending observations to a daemon on behalf
    // of a session nothing can reach.
    const displaced = this.sessions.get(runtime.sessionId);
    if (displaced && displaced !== runtime) {
      const displacedKind = kindOf(runtime.sessionId);
      this.sessions.delete(runtime.sessionId);
      this.disposingCount[displacedKind] += 1;
      void displaced
        // `detached`, not `closed`, for a hosted id — the same distinction the
        // sweep and the shutdown path make. The browser this handle pointed at
        // is still running; a replacement handle to it is being registered
        // right now. Telling the client `closed` would make it tear the
        // session down at the exact moment it came back.
        .close(closeReasonFor(runtime.sessionId))
        .catch(() => {})
        .finally(() => {
          this.disposingCount[displacedKind] -= 1;
          this.stopSweepingIfIdle();
        });
    }
    this.sessions.set(runtime.sessionId, runtime);
    this.touch(runtime);
    // The absolute ceiling applies to a LOCAL session only, and saying so is
    // the honest version of what already happened: a hosted runtime is rebuilt
    // on every replica that re-hydrates it, so `createdAt` restarted and the
    // "hard" deadline silently never arrived.
    //
    // Not a hole worth closing by carrying the original timestamp across,
    // because the deadline would achieve nothing if it did. It bounds a real
    // Chromium window on somebody's machine; a hosted runtime is a HANDLE to a
    // browser on the member's own computer, and expiring it only drops the
    // handle — the browser keeps running either way. What actually bounds that
    // browser is the computer's own idle hibernation, which this process feeds
    // through the keep-awake touch. The 10-minute idle sweep still reclaims
    // the handle, its poll timer and its tool map when nobody is watching.
    runtime.hardExpiresAt =
      kindOf(runtime.sessionId) === "hosted"
        ? 0
        : runtime.createdAt + this.maxLifetimeMs;
    // The runtime published its first session event while attaching, before it
    // had any deadlines to report. Re-publish now that it does, so a client
    // replaying the stream never renders a session that expires at zero.
    runtime.publishSession();
    this.ensureSweeping();
    return runtime.toPublic();
  }

  /** The runtime for this id, or undefined — no throw, for callers that have
   *  a recovery path (hosted re-hydration). */
  peek(sessionId: string): WebMcpSessionRuntime | undefined {
    return this.sessions.get(sessionId);
  }

  get(sessionId: string): WebMcpSessionRuntime {
    const runtime = this.sessions.get(sessionId);
    if (!runtime) {
      throw new WebMcpSessionNotFoundError(
        "That WebMCP session no longer exists. Open the page again to start a new one.",
      );
    }
    return runtime;
  }

  describe(sessionId: string): {
    session: WebMcpSessionPublic;
    tools: WebMcpToolDescriptor[];
  } {
    const runtime = this.get(sessionId);
    this.touch(runtime);
    return { session: runtime.toPublic(), tools: runtime.currentTools() };
  }

  subscribe(
    sessionId: string,
    listener: WebMcpEventListener,
    replay?: number,
  ): () => void {
    const runtime = this.get(sessionId);
    return this.subscribeTo(runtime, listener, replay);
  }

  /**
   * Subscribe to a runtime this caller already resolved, COUNTING the
   * subscriber for as long as it stays attached.
   *
   * The count is load-bearing twice over. It defers idle eviction: the idle
   * clock was only bumped by commands, so a session someone was watching but
   * not driving — the ordinary way to use this feature — was reaped after ten
   * minutes and re-hydrated on the viewer's next event, repeatedly, for as
   * long as they kept watching. And it gates the hosted tool poll, which must
   * not spend the daemon's bounded per-boot command budget producing tool
   * lists that nobody is reading.
   */
  subscribeTo(
    runtime: WebMcpSessionRuntime,
    listener: WebMcpEventListener,
    replay?: number,
  ): () => void {
    this.touch(runtime);
    const id = runtime.sessionId;
    this.subscriberCounts.set(id, (this.subscriberCounts.get(id) ?? 0) + 1);
    const unsubscribe = runtime.hub.subscribe(listener, replay);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = (this.subscriberCounts.get(id) ?? 1) - 1;
      if (next > 0) this.subscriberCounts.set(id, next);
      else this.subscriberCounts.delete(id);
      unsubscribe();
    };
  }

  /** Is anyone attached to this session's event stream on this replica? */
  hasSubscribers(sessionId: string): boolean {
    return (this.subscriberCounts.get(sessionId) ?? 0) > 0;
  }

  /**
   * Push the idle deadline out for every session that is being WATCHED.
   *
   * Called on the stream's own keepalive tick. A subscriber attached at minute
   * zero is evidence at minute zero and nothing after it, so without this a
   * long watch still expires; with it, "somebody has this open" keeps the
   * session for as long as that stays true and not one sweep longer.
   */
  touchWatchedSessions(): void {
    for (const id of this.subscriberCounts.keys()) {
      const runtime = this.sessions.get(id);
      if (runtime) this.touch(runtime);
    }
  }

  /** Push the idle deadline out. Called by API traffic AND browser activity. */
  touch(runtime: WebMcpSessionRuntime): void {
    runtime.expiresAt = this.now() + this.idleTimeoutMs;
  }

  async close(
    sessionId: string,
    options: { reason?: "closed" | "detached" } = {},
  ): Promise<boolean> {
    const runtime = this.sessions.get(sessionId);
    if (!runtime) return false;
    const kind = kindOf(sessionId);
    this.sessions.delete(sessionId);
    this.disposingCount[kind] += 1;
    try {
      await runtime.close(options.reason ?? "closed");
    } finally {
      this.disposingCount[kind] -= 1;
      this.stopSweepingIfIdle();
    }
    return true;
  }

  /**
   * Reap sessions past either deadline. An in-flight invocation defers the
   * reap: tearing the browser down mid-call would settle it as a mystery
   * failure, and the next sweep is only 30 seconds away.
   */
  sweepExpired(): void {
    const now = this.now();
    for (const [id, runtime] of [...this.sessions]) {
      if (runtime.inFlight > 0) continue;
      const idleExpired = runtime.expiresAt > 0 && runtime.expiresAt <= now;
      const lifetimeExpired =
        runtime.hardExpiresAt > 0 && runtime.hardExpiresAt <= now;
      if (idleExpired || lifetimeExpired) {
        // A hosted session DETACHES rather than closes. The browser it names
        // is still running on the member's computer and can be picked up again
        // by any replica; only this process's handle to it is going away.
        // `closed` is terminal to the client and would tell someone their
        // still-live browser had ended.
        void this.close(id, { reason: closeReasonFor(id) });
      }
    }
  }

  private ensureSweeping(): void {
    if (this.sweepTimer || this.sweepIntervalMs <= 0) return;
    this.sweepTimer = setInterval(
      () => this.sweepExpired(),
      this.sweepIntervalMs,
    );
    // Never keep the process alive just to sweep.
    this.sweepTimer.unref?.();
  }

  private stopSweepingIfIdle(): void {
    if (
      this.sessions.size === 0 &&
      this.disposingCount.hosted === 0 &&
      this.disposingCount.local === 0 &&
      this.reservedCount.hosted === 0 &&
      this.reservedCount.local === 0
    ) {
      this.stopSweeping();
    }
  }

  private stopSweeping(): void {
    if (!this.sweepTimer) return;
    clearInterval(this.sweepTimer);
    this.sweepTimer = null;
  }

  async disposeAll(options: { permanent?: boolean } = {}): Promise<void> {
    if (options.permanent) this.shuttingDown = true;
    const ids = [...this.sessions.keys()];
    // Same rule as the sweep: a replica shutting down or being deployed over
    // has not ended anybody's hosted browser, and saying `closed` — which is
    // terminal to the client — would claim it had.
    await Promise.all(
      ids.map((id) => this.close(id, { reason: closeReasonFor(id) })),
    );
    this.stopSweeping();
  }
}

export const webMcpSessions = new WebMcpSessionRegistry();

export interface StartWebMcpSessionOptions {
  url: string;
  provider?: WebMcpBrowserProvider | PlaywrightWebMcpProvider;
  registry?: WebMcpSessionRegistry;
  headless?: boolean;
  /** Omitted means `window` — exactly what every existing caller gets. */
  viewportMode?: WebMcpViewportMode;
  /** Derived rather than issued, for a session other replicas must find. */
  sessionId?: string;
  /** Who may drive it; required whenever `sessionId` is guessable. */
  ownerId?: string;
  /** The viewer's device pixel ratio; omitted means 1. See the provider. */
  devicePixelRatio?: number;
}

/**
 * Launch a browser and register the session.
 *
 * Ordering matters on the failure path: the browser is disposed BEFORE the
 * reservation is released, so a concurrent start cannot claim the freed slot
 * while this one's Chromium is still alive.
 */
export async function startWebMcpSession(
  options: StartWebMcpSessionOptions,
): Promise<WebMcpSessionPublic> {
  const registry = options.registry ?? webMcpSessions;
  const provider = options.provider ?? playwrightWebMcpProvider;
  const reservation = registry.reserve(options.sessionId);
  const runtime = new WebMcpSessionRuntime(options.url, {
    now: () => registry.clock(),
    onActivity: () => registry.touch(runtime),
    ...(options.sessionId ? { sessionId: options.sessionId } : {}),
    ...(options.ownerId ? { ownerId: options.ownerId } : {}),
  });

  try {
    const session = await provider.createSession({
      url: options.url,
      headless: options.headless,
      ...(options.viewportMode ? { viewportMode: options.viewportMode } : {}),
      // Spread rather than passed as `undefined`: a provider that never heard
      // of the field should see a request that does not mention it.
      ...(options.devicePixelRatio !== undefined
        ? { devicePixelRatio: options.devicePixelRatio }
        : {}),
      callbacks: runtime.callbacks(),
    });
    runtime.attach(session);
    return registry.register(runtime, reservation);
  } catch (error) {
    if (error instanceof WebMcpUnsupportedError) {
      // The browser is fine and the page loaded; there is simply nothing to
      // inspect. Marking the session says so precisely instead of failing with
      // a generic error — but the browser still goes, because a window nobody
      // can inspect is not worth a capacity slot.
      runtime.markUnsupported(error.message);
    }
    // Closed for EVERY failure, not just the unsupported one. A browser that
    // launched and then failed to register — the shutdown race, or the cap —
    // is a real Chromium nobody holds a handle to any more.
    await runtime.close().catch(() => {});
    registry.release(reservation);
    throw error;
  }
}

let shutdownWired = false;

/**
 * Tear every browser down on exit. Idempotent module-level latch, wired by the
 * route module at import: a Chromium that outlives its server is invisible to
 * the user and impossible to reclaim from the UI.
 */
export function wireWebMcpShutdown(
  registry: WebMcpSessionRegistry = webMcpSessions,
): void {
  if (shutdownWired) return;
  shutdownWired = true;
  const dispose = () => {
    void registry.disposeAll({ permanent: true });
  };
  // A BACKSTOP, not the primary path. The standalone server calls
  // `shutdownWebMcpSessions` from its own shutdown, which awaits teardown
  // before `process.exit(0)`; these handlers cover the paths that do not run
  // it — the Electron main process, and an exit that bypasses that function.
  process.once("SIGINT", dispose);
  process.once("SIGTERM", dispose);
  process.once("beforeExit", dispose);
}

/**
 * Await every browser's teardown.
 *
 * The signal handlers above cannot be relied on alone: the server's own
 * shutdown calls `process.exit(0)` as soon as its awaits finish, and a
 * fire-and-forget disposal started from a sibling SIGTERM handler loses that
 * race — leaving a Chromium window open with nothing left to close it.
 */
export async function shutdownWebMcpSessions(
  registry: WebMcpSessionRegistry = webMcpSessions,
): Promise<void> {
  await registry.disposeAll({ permanent: true });
}

/** Test seam: lets a suite re-wire the latch. */
export function resetWebMcpShutdownWiringForTests(): void {
  shutdownWired = false;
}
