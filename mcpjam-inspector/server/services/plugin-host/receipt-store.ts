import { createHash } from "node:crypto";
import { createPluginServiceStore } from "./service-store.js";
import { type TrustedInvocationOwner } from "./invocation.js";

import {
  INVOCATION_RECEIPT_PATH,
  INVOCATION_RECEIPT_RESPONSE_BYTES,
  type DurableInvocationLeg,
  type DurableInvocationReceipt,
} from "../../../shared/plugin-invocation-receipts.js";
export type {
  DurableInvocationLeg,
  DurableInvocationReceipt,
} from "../../../shared/plugin-invocation-receipts.js";
export interface PluginInvocationReceiptPort {
  read(
    id: string,
    signal: AbortSignal,
  ): Promise<DurableInvocationReceipt | null>;
  claim(
    id: string,
    input: {
      fingerprint: string;
      revision: string;
      writerHash: string;
      round: number;
      legFingerprint: string;
      continuationId?: string;
    },
    signal: AbortSignal,
  ): Promise<{ claimed: boolean; receipt: DurableInvocationReceipt }>;
  write(
    id: string,
    input: {
      writerHash: string;
      round: number;
      state: Exclude<DurableInvocationLeg["state"], "reserved"> | "refused";
      valueJson?: string;
      errorCode?: string;
      continuationId?: string;
      pendingRound?: number;
    },
    signal: AbortSignal,
  ): Promise<void>;
}
export const pluginReceiptHash = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");

/** Fresh request port. Service credentials never enter an invocation receipt.
 * Scope includes the verified credential subject and every immutable owner field.
 * Persisted results prove no repeat effect; current admission still owns delivery.
 */
export function createPluginInvocationReceiptPort(
  owner: TrustedInvocationOwner,
  subject: string,
  options: { env?: NodeJS.ProcessEnv; fetchImpl?: typeof fetch } = {},
): PluginInvocationReceiptPort | undefined {
  const store = createPluginServiceStore(
    INVOCATION_RECEIPT_PATH,
    INVOCATION_RECEIPT_RESPONSE_BYTES,
    "RECEIPT_STORE_UNAVAILABLE",
    options,
  );
  if (!store) return undefined;
  const ownerHash = pluginInvocationOwnerHash(owner, subject);
  const request = (
    id: string,
    command: Record<string, unknown>,
    signal: AbortSignal,
  ) =>
    store(
      { ...command, scopeHash: pluginReceiptHash([ownerHash, id]) },
      signal,
    );
  return {
    read: async (id, signal) =>
      (await request(id, { action: "read" }, signal)).receipt,
    claim: (id, input, signal) =>
      request(id, { action: "claim", ownerHash, ...input }, signal),
    write: async (id, input, signal) => {
      await request(id, { action: "write", ...input }, signal);
    },
  };
}

export function pluginInvocationOwnerHash(
  owner: TrustedInvocationOwner,
  subject: string,
) {
  return pluginReceiptHash([
    "plugin-invocation-v1",
    subject,
    owner.actorId,
    owner.projectId,
    owner.workspaceId,
    owner.instanceId,
    owner.generation,
    owner.serverId,
    owner.bindingId,
    owner.placement,
    owner.runId ?? null,
  ]);
}
