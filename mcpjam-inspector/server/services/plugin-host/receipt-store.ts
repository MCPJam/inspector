import { createHash } from "node:crypto";
import { createPluginServiceStore } from "./service-store.js";
import {
  PluginInvocationError,
  type TrustedInvocationOwner,
} from "./invocation.js";

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
      /** Claim and mark the leg `dispatched` in one store write. A store
       * that predates it gets a plain claim instead (the leg stays
       * `reserved`); the returned receipt says which happened. */
      dispatch?: true;
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

/** How long a deployment that refused a combined claim is not asked again.
 * A backend deployed later is picked up within this window, with no restart. */
export const PLUGIN_COMBINED_CLAIM_RETRY_MS = 5 * 60_000;
const combinedClaimMissingUntil = new Map<string, number>();
/** Test seam: forget which deployments refused the combined claim. */
export function resetPluginCombinedClaimDetection() {
  combinedClaimMissingUntil.clear();
}

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
  const env = options.env ?? process.env;
  const deployment = `${env.CONVEX_URL?.trim() ?? ""}|${env.CONVEX_HTTP_URL?.trim() ?? ""}`;
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
    claim: async (id, { dispatch, ...input }, signal) => {
      if (
        dispatch &&
        (combinedClaimMissingUntil.get(deployment) ?? 0) <= Date.now()
      ) {
        try {
          return await request(
            id,
            { action: "claim", ownerHash, ...input, dispatch: true },
            signal,
          );
        } catch (error) {
          // A store that predates the combined claim rejects its unknown
          // field before its handler runs, so nothing was written: claim the
          // plain way. Any other answer is the store's own.
          if (
            !(error instanceof PluginInvocationError) ||
            error.code !== "INVALID_RECEIPT_REQUEST"
          )
            throw error;
          combinedClaimMissingUntil.set(
            deployment,
            Date.now() + PLUGIN_COMBINED_CLAIM_RETRY_MS,
          );
        }
      }
      return request(id, { action: "claim", ownerHash, ...input }, signal);
    },
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
