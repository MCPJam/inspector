/**
 * Tunnel session orchestration: grant → local bridge → relay WebSocket,
 * plus the failure policy for the edge's permanent close codes:
 *
 *  - 4000 (bad/expired token): re-create the grant — every create rotates
 *    the secret AND updates the URL stored on the server record — then
 *    reconnect. Capped to avoid remint loops.
 *  - 4001 (replaced) / 4002 (revoked by control plane): exit. A takeover
 *    by another `mcpjam tunnel` usually surfaces as 4002, not 4001: the
 *    mint disconnects the old socket at the edge before the new one
 *    registers.
 *  - Transient drops / 1012: the relay client's own backoff reconnect.
 *
 * Dependencies are injected so tests can drive the policy with stubs.
 */
import type { CreateTunnelResult } from "@mcpjam/sdk/platform";
import {
  CLOSE_BAD_TOKEN,
  CLOSE_CONTROL_PLANE,
  CLOSE_REPLACED,
} from "./relay-client.js";

const MAX_REMINT_ATTEMPTS = 3;
// Remints further apart than this are the healthy path (token expiry over a
// long-lived tunnel) and reset the attempt counter; only rapid-fire 4000
// loops hit the cap.
const REMINT_RESET_WINDOW_MS = 60_000;
const CLOSE_GRANT_TIMEOUT_MS = 5_000;

export interface RelayConnectionLike {
  connect(): Promise<void>;
  close(): void;
  readonly permanentFailure: string | null;
}

export interface LocalBridgeLike {
  localAddr: string;
  close(): Promise<void>;
}

export interface TunnelSessionResult {
  exitCode: number;
  reason?: string;
}

export interface TunnelSessionDeps {
  /**
   * POST /projects/:id/tunnels — also the rotation path. The signal aborts
   * when stop() lands while the mint is in flight; implementations must
   * wire it into the request. (A mint whose response already won the race
   * is revoked by the session's stopped-guards instead.)
   */
  createGrant(signal: AbortSignal): Promise<CreateTunnelResult>;
  /**
   * Best-effort grant revocation on Ctrl-C. The signal aborts when the
   * grace period expires — implementations must wire it into the request
   * so a hung backend can't keep the process alive past the timeout.
   */
  closeGrant(result: CreateTunnelResult, signal: AbortSignal): Promise<void>;
  startBridge(serverId: string): Promise<LocalBridgeLike>;
  connectRelay(options: {
    grant: CreateTunnelResult["grant"];
    localAddr: string;
    onPermanentFailure: (reason: string, closeCode: number) => void;
  }): RelayConnectionLike;
  /** Status line sink (stderr). */
  log(message: string): void;
  /** Fires on the initial grant and again after each rotation. */
  onGrant?(result: CreateTunnelResult, rotated: boolean): void;
  /** Clock seam for tests. */
  now?(): number;
  /** Grace period for closeGrant on stop; tests shrink it. */
  closeGrantTimeoutMs?: number;
}

function permanentCloseMessage(reason: string, closeCode: number): string {
  if (closeCode === CLOSE_REPLACED) {
    return "Tunnel taken over: another session registered a tunnel for this server. Re-run `mcpjam tunnel` here to take it back.";
  }
  if (closeCode === CLOSE_CONTROL_PLANE) {
    return "Tunnel closed or re-created elsewhere (another `mcpjam tunnel` session for this server, or closed from the platform). Re-run `mcpjam tunnel` to recreate it.";
  }
  return reason;
}

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        // Deliberately NOT unref'd: the deadline must fire even when the
        // watched promise holds no event-loop handle, and it's cleared in
        // the finally as soon as the race settles.
        timer = setTimeout(
          () => reject(new Error(`Timed out after ${ms}ms`)),
          ms,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export class TunnelSession {
  private grantResult: CreateTunnelResult | null = null;
  private bridge: LocalBridgeLike | null = null;
  private connection: RelayConnectionLike | null = null;
  private remintAttempts = 0;
  private lastRemintAt: number | null = null;
  private started = false;
  private stopped = false;
  /** True while start()/remint own a connect() — its error path drives. */
  private dialing = false;
  /** True while a remint is rotating; a second 4000 must not start another. */
  private reminting = false;
  /**
   * Permanent close that arrived while we couldn't act on it (mid-dial or
   * pre-start). Consumed by dial()'s post-handshake check or flushed once
   * the session is live, so no event is ever silently dropped.
   */
  private pendingPermanent: { reason: string; closeCode: number } | null =
    null;
  /** Aborts an in-flight grant mint when stop() lands during one. */
  private mintAborter: AbortController | null = null;
  private settled = false;
  private settle!: (result: TunnelSessionResult) => void;
  private readonly closed: Promise<TunnelSessionResult>;

  constructor(private readonly deps: TunnelSessionDeps) {
    this.closed = new Promise<TunnelSessionResult>((resolve) => {
      this.settle = (result) => {
        if (this.settled) return;
        this.settled = true;
        resolve(result);
      };
    });
  }

  /**
   * Create the grant, start the bridge, and connect the relay. Resolves
   * with the grant once the relay handshake succeeded; throws on startup
   * failure (after cleaning up whatever was started).
   */
  async start(): Promise<CreateTunnelResult> {
    try {
      const result = await this.mintGrant();
      this.grantResult = result;
      this.assertNotStopped();
      this.bridge = await this.deps.startBridge(result.grant.serverId);
      this.assertNotStopped();
      await this.dial(result);
      this.assertNotStopped();
      this.started = true;
      this.deps.onGrant?.(result, false);
      this.flushPendingPermanent();
      return result;
    } catch (error) {
      await this.cleanup();
      // The grant may already be minted with its URL persisted on the
      // server record; this session never came up, so don't leave the
      // fresh secret live. Best-effort — the original error is what the
      // caller needs to see.
      await this.revokeGrantBestEffort();
      throw error;
    }
  }

  private async mintGrant(): Promise<CreateTunnelResult> {
    const aborter = new AbortController();
    this.mintAborter = aborter;
    try {
      return await this.deps.createGrant(aborter.signal);
    } finally {
      if (this.mintAborter === aborter) {
        this.mintAborter = null;
      }
    }
  }

  /**
   * A stop() that lands mid-startup owns the session: abandon the bring-up
   * here so start()'s catch tears down and revokes whatever exists by now —
   * including a grant whose mint resolved after stop() already ran its own
   * (then-empty) revocation.
   */
  private assertNotStopped(): void {
    if (this.stopped || this.settled) {
      throw new Error("Tunnel startup interrupted");
    }
  }

  private async revokeGrantBestEffort(): Promise<void> {
    if (!this.grantResult) return;
    const aborter = new AbortController();
    try {
      await withTimeout(
        this.deps.closeGrant(this.grantResult, aborter.signal),
        this.deps.closeGrantTimeoutMs ?? CLOSE_GRANT_TIMEOUT_MS,
      );
    } catch {
      aborter.abort();
      // Best effort: the secret dies with the next create or its expiry.
    }
  }

  waitUntilClosed(): Promise<TunnelSessionResult> {
    return this.closed;
  }

  /** Ctrl-C path: close everything, best-effort revoke, exit 0. */
  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    // Cancel an in-flight mint right away: the request (and its timers)
    // must not outlive the session, and usually no grant gets minted at
    // all. A response that already won the race is revoked by the
    // startup/remint stopped-guards instead.
    this.mintAborter?.abort();
    await this.cleanup();
    if (this.grantResult) {
      // Abort the request when the grace period wins the race — otherwise
      // a hung backend's in-flight fetch (and its own 30s timeout) keeps
      // the process alive long after we told the user we were done.
      const aborter = new AbortController();
      try {
        await withTimeout(
          this.deps.closeGrant(this.grantResult, aborter.signal),
          this.deps.closeGrantTimeoutMs ?? CLOSE_GRANT_TIMEOUT_MS,
        );
        this.deps.log("Tunnel grant revoked.");
      } catch (error) {
        aborter.abort();
        this.deps.log(
          `Could not revoke the tunnel grant (${
            error instanceof Error ? error.message : String(error)
          }); it dies with the next create or its own expiry.`,
        );
      }
    }
    this.settle({ exitCode: 0 });
  }

  private async dial(result: CreateTunnelResult): Promise<void> {
    this.dialing = true;
    this.pendingPermanent = null;
    try {
      const connection = this.deps.connectRelay({
        grant: result.grant,
        localAddr: this.bridge!.localAddr,
        onPermanentFailure: (reason, closeCode) =>
          this.handlePermanentFailure(reason, closeCode),
      });
      this.connection = connection;
      await connection.connect();
      // Handshake-race guard (mirrors the hosted tunnel-manager): a
      // permanent close can land between connect() resolving and this line.
      // Its onPermanentFailure was stashed while we were dialing — consume
      // it (or the connection's own flag) here instead of reporting a dead
      // connection as live.
      const pending = this.pendingPermanent as {
        reason: string;
        closeCode: number;
      } | null;
      if (connection.permanentFailure || pending) {
        this.pendingPermanent = null;
        connection.close();
        throw new Error(connection.permanentFailure ?? pending!.reason);
      }
    } finally {
      this.dialing = false;
    }
  }

  private handlePermanentFailure(reason: string, closeCode: number): void {
    if (this.stopped || this.settled) return;
    // Mid-dial or pre-start we can't act yet: stash instead of dropping.
    // dial()'s post-handshake check or the post-start flush consumes it.
    if (this.dialing || !this.started) {
      this.pendingPermanent = { reason, closeCode };
      return;
    }
    this.dispatchPermanentFailure(reason, closeCode);
  }

  private flushPendingPermanent(): void {
    const pending = this.pendingPermanent;
    if (!pending || this.stopped || this.settled) return;
    this.pendingPermanent = null;
    this.dispatchPermanentFailure(pending.reason, pending.closeCode);
  }

  private dispatchPermanentFailure(reason: string, closeCode: number): void {
    if (closeCode === CLOSE_BAD_TOKEN) {
      // Single-flight: a second 4000 while a rotation is already in
      // progress would mint a grant that instantly revokes the one the
      // in-flight remint is about to connect with.
      if (!this.reminting) {
        void this.remint();
      }
      return;
    }
    void this.fail(permanentCloseMessage(reason, closeCode));
  }

  private async remint(): Promise<void> {
    if (this.reminting) return;
    this.reminting = true;
    try {
      const now = this.deps.now?.() ?? Date.now();
      if (
        this.lastRemintAt !== null &&
        now - this.lastRemintAt > REMINT_RESET_WINDOW_MS
      ) {
        this.remintAttempts = 0;
      }
      this.lastRemintAt = now;
      this.remintAttempts += 1;
      if (this.remintAttempts > MAX_REMINT_ATTEMPTS) {
        await this.fail(
          `Tunnel session expired and could not be renewed after ${MAX_REMINT_ATTEMPTS} rapid attempts.`,
        );
        return;
      }
      this.deps.log(
        `Tunnel session expired; renewing the grant (attempt ${this.remintAttempts}/${MAX_REMINT_ATTEMPTS})...`,
      );
      try {
        this.connection?.close();
        const result = await this.mintGrant();
        this.grantResult = result;
        // A stop()/fail() that landed while the grant was minting owns the
        // session now. Its own revocation may have raced AHEAD of this mint
        // at the backend, so revoke the fresh grant explicitly — issued
        // after the mint response, the ordering is deterministic — instead
        // of leaving a live secret behind an exited session.
        if (this.stopped || this.settled) {
          await this.revokeGrantBestEffort();
          return;
        }
        await this.dial(result);
        // The attempt counter is NOT reset here: a mint that succeeds but
        // gets 4000'd again right away must still run into the cap. The
        // reset is time-based (REMINT_RESET_WINDOW_MS) above.
        this.deps.onGrant?.(result, true);
      } catch (error) {
        // Whatever failed, the latest grant must not outlive this attempt —
        // including the stopped/settled case, where the mint may have
        // completed after stop()'s own revocation (same race as above).
        await this.revokeGrantBestEffort();
        if (this.stopped || this.settled) return;
        await this.fail(
          `Failed to renew the tunnel: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    } finally {
      this.reminting = false;
      // A permanent close stashed during the remint's dial that the
      // post-handshake check didn't consume (success path) acts now.
      this.flushPendingPermanent();
    }
  }

  private async fail(reason: string): Promise<void> {
    await this.cleanup();
    this.settle({ exitCode: 1, reason });
  }

  private async cleanup(): Promise<void> {
    this.connection?.close();
    this.connection = null;
    if (this.bridge) {
      const bridge = this.bridge;
      this.bridge = null;
      await bridge.close().catch(() => {});
    }
  }
}
