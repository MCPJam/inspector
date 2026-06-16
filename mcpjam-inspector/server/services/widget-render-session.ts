/**
 * widget-render-session.ts — a registry of interactive headless widget-render
 * sessions. Each session owns a `keepMounted` McpAppBrowserHarness (a live
 * Chromium tab with the widget mounted) that an external agent steps through via
 * `apps session action`. Backs the `POST/DELETE /api/mcp/widget-session*` route.
 *
 * Browser tabs are expensive and must not leak, so the registry enforces a
 * strict lifecycle:
 *   - max concurrent sessions cap (reject when full),
 *   - idle TTL with `expiresAt` refreshed on each action,
 *   - a periodic sweep that disposes expired sessions, and
 *   - dispose-all on process shutdown (wired by the route module).
 *
 * The registry is intentionally render-agnostic: the route runs the gate-first
 * render (utils/widget-render-core) and hands an already-mounted harness to
 * `register`; the registry only owns lifecycle from there. This keeps it
 * unit-testable with a fake harness and no MCP/browser dependency.
 */

import { randomUUID } from "node:crypto";
import type {
  BrowserActionResult,
  BrowserActionSpec,
  McpAppBrowserHarness,
} from "../utils/mcp-app-browser-harness";
import { logger } from "../utils/logger";

/** The harness surface the registry drives. A real McpAppBrowserHarness
 *  satisfies it; tests pass a fake. */
export type SessionHarness = Pick<
  McpAppBrowserHarness,
  "executeAction" | "dispose"
>;

/** Public (serializable) view of a session — never exposes the harness. */
export interface WidgetRenderSession {
  sessionId: string;
  serverId: string;
  mountedWidgetId: string;
  viewport: { width: number; height: number };
  createdAt: number;
  expiresAt: number;
}

export class WidgetSessionCapacityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WidgetSessionCapacityError";
  }
}

export class WidgetSessionNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WidgetSessionNotFoundError";
  }
}

interface RegisteredSession extends WidgetRenderSession {
  harness: SessionHarness;
  /** Count of in-flight actions. A busy session is never idle-swept, and the
   *  TTL effectively pauses until the action settles. */
  inFlight: number;
}

export interface WidgetRenderSessionRegistryOptions {
  /** Max concurrent live sessions. Default 4. */
  maxSessions?: number;
  /** Idle TTL (ms) refreshed on each action. Default 5 min. */
  idleTimeoutMs?: number;
  /** Background sweep interval (ms); <= 0 disables it (tests sweep manually).
   *  Default 30s. */
  sweepIntervalMs?: number;
  /** Injectable clock for deterministic TTL tests. Default Date.now. */
  now?: () => number;
}

const DEFAULT_MAX_SESSIONS = 4;
const DEFAULT_IDLE_TIMEOUT_MS = 5 * 60_000;
const DEFAULT_SWEEP_INTERVAL_MS = 30_000;

export interface RegisterSessionInput {
  harness: SessionHarness;
  serverId: string;
  mountedWidgetId: string;
  viewport: { width: number; height: number };
}

/**
 * A held capacity slot. `reserve()` returns one synchronously before the
 * (async) render so concurrent starts can't all pass a point-in-time cap check
 * and launch a burst of browsers; `register` consumes it, `release` frees it.
 */
export interface WidgetSessionReservation {
  /** @internal — still holding a slot. */
  active: boolean;
}

export class WidgetRenderSessionRegistry {
  private readonly sessions = new Map<string, RegisteredSession>();
  private readonly maxSessions: number;
  private readonly idleTimeoutMs: number;
  private readonly sweepIntervalMs: number;
  private readonly now: () => number;
  private sweepTimer: ReturnType<typeof setInterval> | null = null;
  /** Sessions removed from the map but whose browser teardown (async
   *  `harness.dispose()`) hasn't finished — they still hold a real Chromium, so
   *  they count against the cap until disposal resolves. */
  private disposingCount = 0;
  /** Slots reserved for in-flight `start` renders (held from `reserve()` until
   *  `register`/`release`), so concurrent starts respect the cap before a
   *  browser is launched. */
  private reservedCount = 0;

  constructor(options: WidgetRenderSessionRegistryOptions = {}) {
    this.maxSessions = options.maxSessions ?? DEFAULT_MAX_SESSIONS;
    this.idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
    this.sweepIntervalMs = options.sweepIntervalMs ?? DEFAULT_SWEEP_INTERVAL_MS;
    this.now = options.now ?? Date.now;
  }

  getIdleTimeoutMs(): number {
    return this.idleTimeoutMs;
  }

  size(): number {
    return this.sessions.size;
  }

  /**
   * Sessions counting against the cap: live sessions, any whose browser is
   * still being torn down (`dispose()` is async — the map entry is gone the
   * instant we delete it, but the Chromium process isn't), and slots reserved
   * for in-flight starts.
   */
  private activeCount(): number {
    return this.sessions.size + this.disposingCount + this.reservedCount;
  }

  private capacityError(): WidgetSessionCapacityError {
    return new WidgetSessionCapacityError(
      `Widget session limit reached (${this.maxSessions} active). Close a session and retry.`,
    );
  }

  /**
   * Reserve a capacity slot for an in-flight start, throwing
   * `WidgetSessionCapacityError` if full (after reclaiming idle sessions). Held
   * synchronously and counted against the cap until `register`/`release`, so a
   * burst of concurrent starts can't each pass a point-in-time check and launch
   * more browsers than the cap allows. The caller MUST `register` (on a
   * successful render) or `release` (otherwise) the returned reservation.
   */
  reserve(): WidgetSessionReservation {
    this.sweepExpired();
    if (this.activeCount() >= this.maxSessions) {
      throw this.capacityError();
    }
    this.reservedCount += 1;
    this.ensureSweeping();
    return { active: true };
  }

  /** Release a reserved slot without registering a session (render failed /
   *  yielded no widget). Idempotent. */
  release(reservation: WidgetSessionReservation): void {
    if (!reservation.active) return;
    reservation.active = false;
    this.reservedCount -= 1;
    if (this.sessions.size === 0 && this.disposingCount === 0 && this.reservedCount === 0) {
      this.stopSweeping();
    }
  }

  /**
   * Register an already-rendered, keepMounted harness as a live session. When a
   * `reservation` is passed it consumes that held slot (no cap re-check); the
   * unreserved path re-checks the cap and throws if full, so the caller must
   * dispose the harness on throw.
   */
  register(
    input: RegisterSessionInput,
    reservation?: WidgetSessionReservation,
  ): WidgetRenderSession {
    if (reservation?.active) {
      // Convert the held slot into a live session (no re-check — it was
      // reserved up front).
      reservation.active = false;
      this.reservedCount -= 1;
    } else {
      this.sweepExpired();
      if (this.activeCount() >= this.maxSessions) {
        throw this.capacityError();
      }
    }

    const createdAt = this.now();
    const session: RegisteredSession = {
      sessionId: randomUUID(),
      serverId: input.serverId,
      mountedWidgetId: input.mountedWidgetId,
      viewport: input.viewport,
      createdAt,
      expiresAt: createdAt + this.idleTimeoutMs,
      harness: input.harness,
      inFlight: 0,
    };
    this.sessions.set(session.sessionId, session);
    this.ensureSweeping();
    return this.toPublic(session);
  }

  /** Public view of a live (non-expired) session, or undefined. */
  get(sessionId: string): WidgetRenderSession | undefined {
    const session = this.sessions.get(sessionId);
    if (!session) return undefined;
    if (this.isIdleExpired(session)) {
      void this.disposeSession(sessionId, "idle");
      return undefined;
    }
    return this.toPublic(session);
  }

  /**
   * Drive a Computer-Use action on a session's mounted widget; refreshes the
   * session's idle TTL. Throws `WidgetSessionNotFoundError` if the session is
   * unknown, expired, or disposed mid-action.
   */
  async executeAction(
    sessionId: string,
    action: BrowserActionSpec,
  ): Promise<{ result: BrowserActionResult; expiresAt: number }> {
    const session = this.sessions.get(sessionId);
    if (!session || this.isIdleExpired(session)) {
      if (session) void this.disposeSession(sessionId, "idle");
      throw new WidgetSessionNotFoundError(
        `Widget session "${sessionId}" not found or expired.`,
      );
    }

    // Mark busy so a concurrent idle sweep won't dispose the session (and its
    // browser) out from under an in-flight action.
    session.inFlight += 1;
    try {
      const result = await session.harness.executeAction({
        toolCallId: session.mountedWidgetId,
        action,
      });
      // A long action may have outlived an explicit close/shutdown; if the
      // session is no longer the registered one, don't report success or
      // refresh the TTL on a session that's gone.
      if (this.sessions.get(sessionId) !== session) {
        throw new WidgetSessionNotFoundError(
          `Widget session "${sessionId}" was closed during the action.`,
        );
      }
      session.expiresAt = this.now() + this.idleTimeoutMs;
      return { result, expiresAt: session.expiresAt };
    } finally {
      session.inFlight -= 1;
    }
  }

  /** Dispose + remove a session. Returns false if it didn't exist. */
  async close(sessionId: string): Promise<boolean> {
    return this.disposeSession(sessionId, "close");
  }

  /** Dispose ALL sessions (idle reclamation on shutdown). */
  async disposeAll(): Promise<void> {
    const ids = [...this.sessions.keys()];
    await Promise.all(ids.map((id) => this.disposeSession(id, "shutdown")));
    this.stopSweeping();
  }

  /** Dispose every idle-expired session (skipping any with an in-flight
   *  action). Collect first, then dispose, so disposal doesn't mutate the map
   *  mid-iteration. */
  sweepExpired(): void {
    const expired: string[] = [];
    for (const [id, session] of this.sessions) {
      if (this.isIdleExpired(session)) expired.push(id);
    }
    for (const id of expired) {
      void this.disposeSession(id, "idle");
    }
  }

  /** Expired by idle TTL AND not currently running an action. A busy session is
   *  always treated as live. */
  private isIdleExpired(session: RegisteredSession): boolean {
    return session.inFlight === 0 && session.expiresAt <= this.now();
  }

  private async disposeSession(
    sessionId: string,
    reason: "close" | "idle" | "shutdown",
  ): Promise<boolean> {
    const session = this.sessions.get(sessionId);
    if (!session) return false;
    this.sessions.delete(sessionId);
    // The browser is still alive until dispose() resolves, so keep counting it
    // against the cap for the duration of the (async) teardown.
    this.disposingCount += 1;
    try {
      await session.harness.dispose();
    } catch (error) {
      logger.warn(
        `[widget-session] dispose failed (${reason}, ${sessionId}): ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    } finally {
      this.disposingCount -= 1;
    }
    if (this.sessions.size === 0 && this.disposingCount === 0) {
      this.stopSweeping();
    }
    return true;
  }

  private ensureSweeping(): void {
    if (this.sweepTimer || this.sweepIntervalMs <= 0) return;
    this.sweepTimer = setInterval(
      () => this.sweepExpired(),
      this.sweepIntervalMs,
    );
    // Don't keep the process alive just for the sweep.
    this.sweepTimer.unref?.();
  }

  private stopSweeping(): void {
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    }
  }

  private toPublic(session: RegisteredSession): WidgetRenderSession {
    return {
      sessionId: session.sessionId,
      serverId: session.serverId,
      mountedWidgetId: session.mountedWidgetId,
      viewport: session.viewport,
      createdAt: session.createdAt,
      expiresAt: session.expiresAt,
    };
  }
}

/**
 * Process-wide registry used by the route (real sweep interval). Browser tabs
 * outlive a request, so this lives at module scope.
 */
export const widgetRenderSessions = new WidgetRenderSessionRegistry();

let shutdownWired = false;

/**
 * Wire process-shutdown disposal of all live sessions (idempotent). Called by
 * the route module so a Ctrl-C / SIGTERM doesn't orphan browser contexts.
 */
export function wireWidgetSessionShutdown(
  registry: WidgetRenderSessionRegistry = widgetRenderSessions,
): void {
  if (shutdownWired) return;
  shutdownWired = true;
  const dispose = () => {
    void registry.disposeAll();
  };
  process.once("SIGINT", dispose);
  process.once("SIGTERM", dispose);
  process.once("beforeExit", dispose);
}
