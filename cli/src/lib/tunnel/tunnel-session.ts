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
  /** POST /projects/:id/tunnels — also the rotation path. */
  createGrant(): Promise<CreateTunnelResult>;
  /** Best-effort grant revocation on Ctrl-C. */
  closeGrant(result: CreateTunnelResult): Promise<void>;
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
        timer = setTimeout(
          () => reject(new Error(`Timed out after ${ms}ms`)),
          ms,
        );
        timer.unref?.();
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
      const result = await this.deps.createGrant();
      this.grantResult = result;
      this.bridge = await this.deps.startBridge(result.grant.serverId);
      await this.dial(result);
      this.started = true;
      this.deps.onGrant?.(result, false);
      return result;
    } catch (error) {
      await this.cleanup();
      throw error;
    }
  }

  waitUntilClosed(): Promise<TunnelSessionResult> {
    return this.closed;
  }

  /** Ctrl-C path: close everything, best-effort revoke, exit 0. */
  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    await this.cleanup();
    if (this.grantResult) {
      try {
        await withTimeout(
          this.deps.closeGrant(this.grantResult),
          CLOSE_GRANT_TIMEOUT_MS,
        );
        this.deps.log("Tunnel grant revoked.");
      } catch (error) {
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
      // permanent close can land between connect() resolving and this line;
      // its onPermanentFailure is ignored while we're dialing, so check the
      // flag synchronously instead of reporting a dead connection as live.
      if (connection.permanentFailure) {
        connection.close();
        throw new Error(connection.permanentFailure);
      }
    } finally {
      this.dialing = false;
    }
  }

  private handlePermanentFailure(reason: string, closeCode: number): void {
    if (this.stopped || this.settled || this.dialing || !this.started) return;
    if (closeCode === CLOSE_BAD_TOKEN) {
      void this.remint();
      return;
    }
    void this.fail(permanentCloseMessage(reason, closeCode));
  }

  private async remint(): Promise<void> {
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
      const result = await this.deps.createGrant();
      this.grantResult = result;
      await this.dial(result);
      // The attempt counter is NOT reset here: a mint that succeeds but gets
      // 4000'd again right away must still run into the cap. The reset is
      // time-based (REMINT_RESET_WINDOW_MS) at the top of this method.
      this.deps.onGrant?.(result, true);
    } catch (error) {
      if (this.stopped || this.settled) return;
      await this.fail(
        `Failed to renew the tunnel: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
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
