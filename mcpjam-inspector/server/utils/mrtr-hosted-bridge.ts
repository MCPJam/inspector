/**
 * Hosted **chat/agent-loop** MRTR bridge (MCP 2026-07-28 §12.5, PR5).
 *
 * The suspending analog of {@link HostedElicitationBridge}. Where the
 * elicitation bridge BLOCKS a tool call on an SSE-held rendezvous, this bridge
 * SUSPENDS: it hands the per-server manager a collector that persists the
 * operation to the durable continuation store, emits a `data-mrtr-input-
 * required` part, and throws `MrtrSuspendedSignal` to return control to the
 * worker (§12.5.2 forbids blocking).
 *
 * ## Two connect-time races, both handled by construction
 *
 * 1. The collector must be registered SYNCHRONOUSLY before the manager's
 *    connect microtask, or `buildCapabilities` strips `elicitation` and the
 *    server never embeds a round. So {@link mrtrInputCollectorForServer} is
 *    passed to `createAuthorizedManager` and runs before any `await`.
 * 2. The binding fingerprint + negotiated era need the connection's negotiated
 *    identity, which does NOT exist at factory time. So the collector receives
 *    THUNKS: they are evaluated inside the collector invocation — which happens
 *    mid-tool-call, i.e. after connect. The manager reference is injected via
 *    {@link setManager} once `createAuthorizedManager` returns.
 *
 * The stream writer (for `emit`) also arrives late, via
 * {@link attachStreamWriter} at `onStreamWriterReady` — same discipline as the
 * elicitation bridge.
 *
 * Unlike elicitation rendezvous rows, MRTR continuations are DURABLE and
 * intentionally OUTLIVE the turn (a human answers out of band on a fresh
 * request), so there is no end-of-turn dispose/cancel here.
 */
import type { UIMessageChunk } from "ai";
import type { MrtrInputCollector } from "@mcpjam/sdk";
import {
  HOSTED_MRTR_DATA_PART_TYPE,
  type MrtrContinuationEvent,
} from "@/shared/mrtr-continuation";
import {
  createHostedMrtrCollector,
  computeMrtrBindingFingerprintFromManager,
  deriveNegotiatedEra,
  type MrtrFingerprintManager,
} from "./mrtr-hosted-collector.js";
import { MRTR_CONTINUATION_TTL_MS } from "../config.js";
import { logger } from "./logger.js";

type ChunkWriter = { write: (chunk: UIMessageChunk) => void };

export interface HostedMrtrBridgeOptions {
  /** Convex-valid bearer (`getConvexBearerForRequest(c)`), NOT the raw header. */
  bearer: string;
  projectId: string;
  chatSessionId?: string;
  /** Display labels only; `serverId` stays the trusted anchor. */
  serverNamesById: Record<string, string>;
  /** Resolved auth principal (user / guest id) — the fingerprint's principal half. */
  authPrincipal: string;
  ttlMs?: number;
}

export class HostedMrtrBridge {
  private writer: ChunkWriter | null = null;
  private manager: MrtrFingerprintManager | null = null;

  constructor(private readonly options: HostedMrtrBridgeOptions) {}

  attachStreamWriter(writer: ChunkWriter): void {
    this.writer = writer;
  }

  /**
   * Inject the live manager once `createAuthorizedManager` has returned. The
   * collector's fingerprint/era thunks read it at suspend time (post-connect).
   */
  setManager(manager: MrtrFingerprintManager): void {
    this.manager = manager;
  }

  /**
   * The `mrtrInputCollectorForServer` factory passed to
   * `createAuthorizedManager`. Runs synchronously before connect; returns a
   * collector whose fingerprint/era are resolved lazily.
   */
  readonly mrtrInputCollectorForServer = (
    serverId: string,
  ): MrtrInputCollector | undefined => {
    return createHostedMrtrCollector({
      bearer: this.options.bearer,
      projectId: this.options.projectId,
      serverId,
      ...(this.options.serverNamesById[serverId]
        ? { serverName: this.options.serverNamesById[serverId] }
        : {}),
      ...(this.options.chatSessionId
        ? { chatSessionId: this.options.chatSessionId }
        : {}),
      negotiatedEra: () => this.resolveNegotiatedEra(serverId),
      bindingFingerprint: () => this.resolveBindingFingerprint(serverId),
      emit: (event) => this.emit(event),
      ttlMs: this.options.ttlMs ?? MRTR_CONTINUATION_TTL_MS,
    });
  };

  private requireManager(): MrtrFingerprintManager {
    if (!this.manager) {
      // Reached only if a collector fires before setManager — a wiring bug.
      throw new Error(
        "[mrtr-bridge] manager not attached before an MRTR round; cannot bind continuation",
      );
    }
    return this.manager;
  }

  private resolveNegotiatedEra(serverId: string): string {
    return deriveNegotiatedEra(this.requireManager(), serverId);
  }

  private resolveBindingFingerprint(serverId: string): string {
    const manager = this.requireManager();
    return computeMrtrBindingFingerprintFromManager(manager, {
      serverId,
      negotiatedEra: deriveNegotiatedEra(manager, serverId),
      authPrincipal: this.options.authPrincipal,
    });
  }

  private emit(event: MrtrContinuationEvent): void {
    if (!this.writer) {
      logger.warn("[mrtr-bridge] emit with no live stream writer; dropping part");
      return;
    }
    try {
      this.writer.write({
        type: HOSTED_MRTR_DATA_PART_TYPE,
        data: event,
        transient: true,
      } as unknown as UIMessageChunk);
    } catch (error) {
      logger.warn("[mrtr-bridge] stream write failed", { error });
      this.writer = null;
    }
  }
}
