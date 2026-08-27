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
import { WebMcpUnsupportedError, type WebMcpBrowserProvider } from "./provider";
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
  /** Idle TTL, refreshed by API calls and by browser activity. Default 10 min. */
  idleTimeoutMs?: number;
  /** Hard ceiling regardless of activity. Default 60 min. */
  maxLifetimeMs?: number;
  /** Sweep interval; <= 0 disables the timer (tests sweep by hand). Default 30s. */
  sweepIntervalMs?: number;
  now?: () => number;
}

const DEFAULT_MAX_SESSIONS = 2;
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
  private readonly maxSessions: number;
  private readonly idleTimeoutMs: number;
  private readonly maxLifetimeMs: number;
  private readonly sweepIntervalMs: number;
  private readonly now: () => number;
  private sweepTimer: ReturnType<typeof setInterval> | null = null;
  /** Removed from the map, but their Chromium is still going away. */
  private disposingCount = 0;
  private reservedCount = 0;
  private readonly reservationIds = new Set<string>();
  private shuttingDown = false;

  constructor(options: WebMcpSessionRegistryOptions = {}) {
    this.maxSessions = options.maxSessions ?? DEFAULT_MAX_SESSIONS;
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

  private activeCount(): number {
    return this.sessions.size + this.disposingCount + this.reservedCount;
  }

  reserve(): WebMcpSessionReservation {
    if (this.shuttingDown) {
      throw new WebMcpSessionUnavailableError(
        "The WebMCP Inspector is shutting down.",
      );
    }
    this.sweepExpired();
    if (this.activeCount() >= this.maxSessions) {
      throw new WebMcpSessionCapacityError(
        `Only ${this.maxSessions} WebMCP browser sessions can run at once. Close one and try again.`,
      );
    }
    const reservation: WebMcpSessionReservation = {
      id: randomUUID(),
      active: true,
    };
    this.reservationIds.add(reservation.id);
    this.reservedCount += 1;
    this.ensureSweeping();
    return reservation;
  }

  release(reservation: WebMcpSessionReservation): void {
    if (!this.reservationIds.delete(reservation.id)) return;
    reservation.active = false;
    this.reservedCount -= 1;
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
    } else if (this.activeCount() >= this.maxSessions) {
      throw new WebMcpSessionCapacityError(
        `Only ${this.maxSessions} WebMCP browser sessions can run at once.`,
      );
    }
    this.sessions.set(runtime.sessionId, runtime);
    this.touch(runtime);
    runtime.hardExpiresAt = runtime.createdAt + this.maxLifetimeMs;
    // The runtime published its first session event while attaching, before it
    // had any deadlines to report. Re-publish now that it does, so a client
    // replaying the stream never renders a session that expires at zero.
    runtime.publishSession();
    this.ensureSweeping();
    return runtime.toPublic();
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
    this.touch(runtime);
    return runtime.hub.subscribe(listener, replay);
  }

  /** Push the idle deadline out. Called by API traffic AND browser activity. */
  touch(runtime: WebMcpSessionRuntime): void {
    runtime.expiresAt = this.now() + this.idleTimeoutMs;
  }

  async close(sessionId: string): Promise<boolean> {
    const runtime = this.sessions.get(sessionId);
    if (!runtime) return false;
    this.sessions.delete(sessionId);
    this.disposingCount += 1;
    try {
      await runtime.close();
    } finally {
      this.disposingCount -= 1;
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
        void this.close(id);
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
      this.disposingCount === 0 &&
      this.reservedCount === 0
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
    await Promise.all(ids.map((id) => this.close(id)));
    this.stopSweeping();
  }
}

export const webMcpSessions = new WebMcpSessionRegistry();

export interface StartWebMcpSessionOptions {
  url: string;
  provider?: WebMcpBrowserProvider | PlaywrightWebMcpProvider;
  registry?: WebMcpSessionRegistry;
  headless?: boolean;
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
  const reservation = registry.reserve();
  const runtime = new WebMcpSessionRuntime(options.url, {
    now: () => registry.clock(),
    onActivity: () => registry.touch(runtime),
  });

  try {
    const session = await provider.createSession({
      url: options.url,
      headless: options.headless,
      callbacks: runtime.callbacks(),
    });
    runtime.attach(session);
    return registry.register(runtime, reservation);
  } catch (error) {
    if (error instanceof WebMcpUnsupportedError) {
      // The browser is fine and the page loaded; there is simply nothing to
      // inspect. Keeping the session lets the UI say so precisely instead of
      // failing the whole request — but the browser is torn down, because a
      // window nobody can inspect is not worth a capacity slot.
      runtime.markUnsupported(error.message);
      await runtime.close();
    }
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
  process.once("SIGINT", dispose);
  process.once("SIGTERM", dispose);
  process.once("beforeExit", dispose);
}

/** Test seam: lets a suite re-wire the latch. */
export function resetWebMcpShutdownWiringForTests(): void {
  shutdownWired = false;
}
