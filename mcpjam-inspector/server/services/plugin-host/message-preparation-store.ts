import { randomBytes } from "node:crypto";
import { PLUGIN_MESSAGE_PREPARATION_MS } from "../../../shared/plugin-message.js";
import {
  INVOCATION_RECEIPT_PATH,
  INVOCATION_RECEIPT_RESPONSE_BYTES,
} from "../../../shared/plugin-invocation-receipts.js";
import { PluginInvocationError } from "./invocation.js";
import {
  createPluginInstanceControlPort,
  pluginInstanceIdentityHash,
} from "./instance-store.js";
import { pluginReceiptHash } from "./receipt-store.js";
import {
  createPluginServiceStore,
  type PluginServiceStoreOptions,
} from "./service-store.js";
import { pluginLocalStoresEnabled } from "./local-store.js";
import {
  messagePreparations,
  type MessagePreparation,
  type MessagePreparationIdentity,
  type MessagePreparationStore,
} from "./message-preparations.js";

const KIND = "message-preparation-v1";
/** Refusals that mean "no such live preparation for you, or not this
 * destination". Store outages keep their own codes. */
const REFUSED = new Set([
  "INSTANCE_UNAVAILABLE",
  "INSTANCE_DENIED",
  "INVOCATION_ID_REUSED",
  "AUTHORIZATION_CHANGED",
  "CONTINUATION_INPUT_REUSED",
  "RECEIPT_EXPIRED",
]);
const unavailable = () =>
  new PluginInvocationError("INSTANCE_MESSAGE_UNAVAILABLE");
const refused = (error: unknown) =>
  error instanceof PluginInvocationError && REFUSED.has(error.code)
    ? unavailable()
    : error;
const storeUnavailable = () =>
  new PluginInvocationError("INSTANCE_STORE_UNAVAILABLE");

/**
 * Hosted replicas share preparations through the existing service stores, so
 * a message prepared on one replica can start its new chat on another:
 * - the record is an App instance control row, in a bucket of its own per
 *   user (never listed with their Apps) and under a key no App handle can
 *   produce. The row's lease is the
 *   preparation's 60 seconds, and the store's live limit per identity (512)
 *   caps how many one user holds;
 * - the single destination is an invocation receipt claim owned by that row.
 *   The first claim wins, the same destination claims again, any other is
 *   refused, and the backend refuses every claim once the row has expired.
 */
export function createDurableMessagePreparations(
  options: PluginServiceStoreOptions = {},
  now: () => number = Date.now,
): MessagePreparationStore {
  // Preparations get their own identity bucket, apart from the caller's Apps
  // and without a workspace (see `MessagePreparationIdentity`), so the store's
  // per-identity live limit caps them on their own.
  const scope = ({
    actorId,
    projectId,
    subject,
  }: MessagePreparationIdentity) => ({
    actorId,
    projectId,
    subject,
    workspaceId: KIND,
  });
  const controls = (identity: MessagePreparationIdentity) => {
    const port = createPluginInstanceControlPort(scope(identity), options);
    if (!port) throw storeUnavailable();
    return port;
  };
  const controlKey = (token: string) => `${KIND}:${token}`;
  const ownerHash = (identity: MessagePreparationIdentity, token: string) =>
    pluginReceiptHash([
      KIND,
      pluginInstanceIdentityHash(scope(identity)),
      token,
    ]);
  const read = async (
    token: string,
    identity: MessagePreparationIdentity,
    signal: AbortSignal,
  ) => {
    const control = await controls(identity)
      .read(controlKey(token), signal)
      .catch((error: unknown) => {
        throw refused(error);
      });
    if (!control || control.expiresAt <= now()) throw unavailable();
    let record: Partial<MessagePreparation> & { kind?: unknown };
    try {
      record = JSON.parse(control.snapshotJson);
    } catch {
      throw unavailable();
    }
    const { kind, ...prepared } = record;
    if (
      kind !== KIND ||
      Object.entries(identity).some(
        ([key, value]) => prepared[key as keyof MessagePreparation] !== value,
      ) ||
      typeof prepared.serverId !== "string" ||
      typeof prepared.toolName !== "string" ||
      typeof prepared.revision !== "string"
    )
      throw unavailable();
    return prepared as MessagePreparation;
  };
  return {
    async issue(value, signal) {
      const token = randomBytes(32).toString("base64url");
      await controls(value).issue(
        controlKey(token),
        {
          snapshotJson: JSON.stringify({ kind: KIND, ...value }),
          ownerHash: ownerHash(value, token),
          expiresAt: now() + PLUGIN_MESSAGE_PREPARATION_MS,
        },
        signal,
      );
      return token;
    },
    read,
    async bind(token, identity, destination, signal) {
      // The claim alone would accept an owner with no row at all.
      await read(token, identity, signal);
      const receipts = createPluginServiceStore(
        INVOCATION_RECEIPT_PATH,
        INVOCATION_RECEIPT_RESPONSE_BYTES,
        "RECEIPT_STORE_UNAVAILABLE",
        options,
      );
      if (!receipts) throw storeUnavailable();
      const owner = ownerHash(identity, token);
      const fingerprint = pluginReceiptHash([KIND, "destination", destination]);
      await receipts(
        {
          action: "claim",
          ownerHash: owner,
          scopeHash: pluginReceiptHash([owner, "bind"]),
          fingerprint,
          legFingerprint: fingerprint,
          revision: KIND,
          writerHash: pluginReceiptHash([KIND, "writer", owner]),
          round: 0,
        },
        signal,
      ).catch((error: unknown) => {
        throw refused(error);
      });
    },
  };
}

/** Local installs keep preparations in this process; anything else (hosted,
 * or a local install with the service credential) shares the durable store. */
export function messagePreparationStore(
  options: PluginServiceStoreOptions = {},
): MessagePreparationStore {
  return pluginLocalStoresEnabled(options.env, options.hosted)
    ? messagePreparations
    : createDurableMessagePreparations(options);
}
