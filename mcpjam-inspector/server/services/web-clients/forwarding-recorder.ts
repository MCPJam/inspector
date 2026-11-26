/**
 * What the forwarding endpoint records: every frame the vendor's MCP client
 * and the project's server exchanged, filed under the MCPJam turn it belongs
 * to, and who the client said it was. Frames go where the hosted harness
 * forward proxy sends its own (the Logs panel bus and the shared sink), so a
 * turn streaming on another replica still sees them.
 *
 * Observation only: the endpoint calls these inside its own guard, and
 * nothing here may fail or slow the forwarded request.
 */
import { createHash } from "node:crypto";
import { redactForTelemetry } from "@mcpjam/sdk";
import { probeSerializedSize } from "../../../shared/rpc-log-truncation.js";
import { enqueueHarnessRpcLog } from "../../utils/harness/harness-rpc-log-sink.js";
import { logger } from "../../utils/logger.js";
import { rpcLogBus } from "../rpc-log-bus.js";
import type { WebConnector } from "./connectors.js";

/** The client's identity where its era puts it. */
export type WebClientIdentity = {
  connectorId: string;
  scopeId: string;
  /** The `initialize` request, or each request's `_meta` from 2026-07-28 on. */
  source: "initialize" | "request_meta";
  userAgent?: string;
  protocolVersion?: unknown;
  clientInfo?: unknown;
  clientCapabilities?: unknown;
};

export interface WebClientRecorder {
  frame(args: {
    connector: WebConnector;
    scopeId: string;
    direction: "send" | "receive";
    message: unknown;
  }): void;
  client(identity: WebClientIdentity): void;
}

/**
 * A capability connector's id is its credential, so logs and the shared
 * sink name a connector by this digest, never by its id.
 */
export function connectorTag(connectorId: string): string {
  return createHash("sha256").update(connectorId).digest("hex").slice(0, 16);
}

/** A turn's frames are filed under its id; calls outside any turn under the connector. */
export function webClientScope(connectorId: string, turnId?: string): string {
  return turnId
    ? `web-client:${turnId}`
    : `web-client:outside-turn:${connectorTag(connectorId)}`;
}

const FRAME_LIMIT_BYTES = 1024 * 1024;
const MAX_IDENTITIES = 500;

function safeForLog(value: unknown): unknown {
  if (value === undefined) return undefined;
  // Truncating first can turn a credential string into a preview object
  // that a key-based redactor no longer recognizes as a secret.
  return probeSerializedSize(value, FRAME_LIMIT_BYTES).exceeded
    ? { _truncated: true, limitBytes: FRAME_LIMIT_BYTES }
    : redactForTelemetry(value);
}

function clientName(clientInfo: unknown): string | undefined {
  if (!clientInfo || typeof clientInfo !== "object") return undefined;
  const { name, version } = clientInfo as { name?: unknown; version?: unknown };
  return typeof name === "string"
    ? `${name}${typeof version === "string" ? ` ${version}` : ""}`
    : undefined;
}

export function createWebClientRecorder() {
  const identities: Array<{
    key: string;
    identity: WebClientIdentity & { seenAt: string };
  }> = [];
  return {
    frame({ connector, scopeId, direction, message }) {
      const safe = safeForLog(message);
      const timestamp = new Date().toISOString();
      rpcLogBus.publish({
        serverId: connector.serverId,
        scopeId,
        direction,
        timestamp,
        message: safe,
      });
      enqueueHarnessRpcLog({
        serverId: connector.serverId,
        scopeId,
        direction,
        loggedAt: timestamp,
        projectId: connector.projectId,
        ...(connector.organizationId
          ? { organizationId: connector.organizationId }
          : {}),
        message: safe,
      });
    },
    client(identity) {
      const safe: WebClientIdentity = {
        ...identity,
        clientInfo: safeForLog(identity.clientInfo),
        clientCapabilities: safeForLog(identity.clientCapabilities),
      };
      // A 2026-07-28 client repeats its identity on every request.
      const key = JSON.stringify(safe);
      if (identities.some((entry) => entry.key === key)) return;
      identities.push({
        key,
        identity: { ...safe, seenAt: new Date().toISOString() },
      });
      if (identities.length > MAX_IDENTITIES) identities.shift();
      logger.info("[web-clients] vendor client identified", {
        connector: connectorTag(safe.connectorId),
        scopeId: safe.scopeId,
        source: safe.source,
        client: clientName(safe.clientInfo),
        userAgent: safe.userAgent,
      });
    },
    /** The clients seen in one scope, oldest first, for the run's trace. */
    clientsIn(scopeId: string) {
      return identities
        .map((entry) => entry.identity)
        .filter((identity) => identity.scopeId === scopeId);
    },
  } satisfies WebClientRecorder & { clientsIn(scopeId: string): unknown };
}

/** The process-wide recorder the endpoint writes and the runtime reads. */
export const webClientRecorder = createWebClientRecorder();
