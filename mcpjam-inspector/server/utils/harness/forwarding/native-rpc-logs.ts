import { createHash } from "node:crypto";
import { redactForTelemetry, type RpcLogger } from "@mcpjam/sdk";
import { rpcLogBus } from "../../../services/rpc-log-bus.js";
import { logger } from "../../logger.js";
import { probeSerializedSize } from "../../../../shared/rpc-log-truncation.js";
import { enqueueHarnessRpcLog } from "../harness-rpc-log-sink.js";
import type { ForwardingOwner } from "./execution-control.js";

/** The same server can serve concurrent accounts and turns on different replicas. */
export function nativeRpcLogScope(
  owner: ForwardingOwner,
  turnId: string,
): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        owner.kind,
        owner.userId,
        owner.serverId,
        owner.connectionId ?? null,
        owner.kind === "chat"
          ? owner.harnessSessionId
          : [
              owner.sandboxRowId,
              owner.owner.kind,
              owner.owner.kind === "eval"
                ? owner.owner.iterationId
                : owner.owner.attemptId,
            ],
        turnId,
      ]),
    )
    .digest("hex");
}

/** Observe only JSON-RPC bodies; credentials and routing headers never enter either sink. */
export function createNativeRpcLogger(args: {
  owner: ForwardingOwner;
  turnId: string;
  projectId: string;
  organizationId: string;
}): RpcLogger {
  const scopeId = nativeRpcLogScope(args.owner, args.turnId);
  return ({ direction, message }) => {
    try {
      const limit = 1024 * 1024;
      // Truncating first can turn a credential string into a preview object
      // that a key-based redactor no longer recognizes as a secret.
      const safe = probeSerializedSize(message, limit).exceeded
        ? { _truncated: true, limitBytes: limit }
        : redactForTelemetry(message);
      const timestamp = new Date().toISOString();
      rpcLogBus.publish({
        serverId: args.owner.serverId,
        scopeId,
        direction,
        timestamp,
        message: safe,
      });
      enqueueHarnessRpcLog({
        serverId: args.owner.serverId,
        scopeId,
        direction,
        loggedAt: timestamp,
        projectId: args.projectId,
        organizationId: args.organizationId,
        message: safe,
      });
    } catch {
      // Logs are observation-only; dispatch and authoritative receipts are independent.
      logger.warn("Native MCP log could not be recorded");
    }
  };
}
