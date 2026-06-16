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

export class WidgetRenderSessionRegistry {
  private readonly sessions = new Map<string, RegisteredSession>();
  private readonly maxSessions: number;
  private readonly idleTimeoutMs: number;
  private readonly sweepIntervalMs: number;
  private readonly now: () => number;
  private sweepTimer: ReturnType<typeof setInterval> | null = null;

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
   * Throw `WidgetSessionCapacityError` if at capacity (after reclaiming idle
   * sessions first). Call BEFORE the expensive render so a full registry
   * doesn't launch a browser only to reject it.
   */
  assertCapacity(): void {
    this.sweepExpired();
    if (this.sessions.size >= this.maxSessions) {
      throw new WidgetSessionCapacityError(
        `Widget session limit reached (${this.maxSessions} active). Close a session and retry.`,
      );
    }
  }

  /**
   * Register an already-rendered, keepMounted harness as a live session.
   * Re-checks the cap (authoritative; the pre-render `assertCapacity` is an
   * optimization that can race), so the caller must dispose the harness if this
   * throws.
   */
  register(input: RegisterSessionInput): WidgetRenderSession {
    this.sweepExpired();
    if (this.sessions.size >= this.maxSessions) {
      throw new WidgetSessionCapacityError(
        `Widget session limit reached (${this.maxSessions} active). Close a session and retry.`,
      );
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
    };
    this.sessions.set(session.sessionId, session);
    this.ensureSweeping();
    return this.toPublic(session);
  }

  /** Public view of a live (non-expired) session, or undefined. */
  get(sessionId: string): WidgetRenderSession | undefined {
    const session = this.sessions.get(sessionId);
    if (!session) return undefined;
    if (this.isExpired(session)) {
      void this.disposeSession(sessionId, "idle");
      return undefined;
    }
    return this.toPublic(session);
  }

  /**
   * Drive a Computer-Use action on a session's mounted widget; refreshes the
   * session's idle TTL. Throws `WidgetSessionNotFoundError` if the session is
   * unknown or expired.
   */
  async executeAction(
    sessionId: string,
    action: BrowserActionSpec,
  ): Promise<{ result: BrowserActionResult; expiresAt: number }> {
    const session = this.sessions.get(sessionId);
    if (!session || this.isExpired(session)) {
      if (session) void this.disposeSession(sessionId, "idle");
      throw new WidgetSessionNotFoundError(
        `Widget session "${sessionId}" not found or expired.`,
      );
    }

    const result = await session.harness.executeAction({
      toolCallId: session.mountedWidgetId,
      action,
    });
    // Touch the TTL after the action settles.
    session.expiresAt = this.now() + this.idleTimeoutMs;
    return { result, expiresAt: session.expiresAt };
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

  /** Dispose every session whose idle TTL has elapsed. */
  sweepExpired(): void {
    for (const [id, session] of this.sessions) {
      if (this.isExpired(session)) {
        void this.disposeSession(id, "idle");
      }
    }
  }

  private isExpired(session: RegisteredSession): boolean {
    return session.expiresAt <= this.now();
  }

  private async disposeSession(
    sessionId: string,
    reason: "close" | "idle" | "shutdown",
  ): Promise<boolean> {
    const session = this.sessions.get(sessionId);
    if (!session) return false;
    this.sessions.delete(sessionId);
    try {
      await session.harness.dispose();
    } catch (error) {
      logger.warn(
        `[widget-session] dispose failed (${reason}, ${sessionId}): ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    if (this.sessions.size === 0) {
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
