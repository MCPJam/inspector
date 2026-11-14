import { randomBytes, randomUUID } from "node:crypto";
import { z } from "zod";
import { logger } from "../../utils/logger.js";
import { PLUGIN_MODEL_APP_META } from "../../../shared/plugin-model-app.js";
import {
  PLUGIN_INSTANCE_CONTROL_BYTES,
  type DurablePluginInstanceControl,
} from "../../../shared/plugin-invocation-receipts.js";
import { pluginResourceUri, pluginServerIdentitySchema } from "./bindings.js";
import type { PluginFormOwner, PluginInstanceIdentity } from "./instances.js";
import { PluginInvocationError } from "./invocation.js";
import type { PluginInstanceControlPort } from "./instance-store.js";
import {
  pluginInvocationOwnerHash,
  pluginReceiptHash,
} from "./receipt-store.js";

const id = z.string().min(1).max(4096);
/**
 * A model App's durable control: the App owner the completed model call
 * published, and the exact tool and resource it shows. It is issued without
 * an activation, so its own `kind` marks it; the store renews it as a model
 * App and never reissues it. It carries no credential, connection or callback.
 */
export const modelAppControlSchema = z.strictObject({
  version: z.literal(1),
  kind: z.literal("model-app"),
  /** The original deadline; the stored lease may only extend it. */
  expiresAt: z.number().int().positive(),
  instance: z.strictObject({
    owner: z.strictObject({
      actorId: id,
      projectId: id,
      workspaceId: id,
      instanceId: z.string().uuid(),
      generation: z.literal(1),
      serverId: id,
      bindingId: id,
      placement: z.literal("interactive"),
    }),
    hostId: id,
    hostRevision: id,
    serverIdentity: pluginServerIdentitySchema,
    toolName: id,
    revision: id,
    resourceUri: z.string().startsWith("ui://").max(4096),
  }),
});
export type ModelAppControl = z.infer<typeof modelAppControlSchema>;

/** Whether a stored control is a model App's, before choosing its registry.
 * A malformed snapshot is no model App; its own registry refuses it. */
export function isModelAppControl(saved: DurablePluginInstanceControl | null) {
  if (!saved) return false;
  try {
    return JSON.parse(saved.snapshotJson)?.kind === "model-app";
  } catch {
    return false;
  }
}

/** The App owner's credential subject and identity, as the store keys it. */
const modelAppIdentity = (
  owner: PluginFormOwner,
): PluginInstanceIdentity => ({
  actorId: owner.owner.actorId,
  projectId: owner.owner.projectId,
  workspaceId: owner.owner.workspaceId,
  subject: owner.subject,
});

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);
const withMarker = (result: Record<string, unknown>, marker: object) => ({
  ...result,
  _meta: {
    ...(isRecord(result._meta) ? result._meta : {}),
    [PLUGIN_MODEL_APP_META]: marker,
  },
});

/**
 * Publish a completed model call's App: issue its durable control, then
 * return the result with the App's marker. Runs inside the call's
 * execute/resume, so its receipt keeps this marker and a replay never
 * publishes again. The tool has already run: when the control cannot be
 * stored, the result keeps its content and its marker says the App is
 * unavailable, so no marker ever names an App no replica can restore.
 */
export async function publishModelApp(
  input: {
    result: unknown;
    source: PluginFormOwner;
    toolName: string;
    revision: string;
    toolMeta: unknown;
    expiresAt: number;
    signal: AbortSignal;
  },
  portFor: (
    identity: PluginInstanceIdentity,
  ) => PluginInstanceControlPort | undefined,
) {
  const { result, source } = input;
  if (!isRecord(result) || result.isError === true) return result;
  let resourceUri: string;
  try {
    resourceUri = pluginResourceUri(
      isRecord(input.toolMeta) ? input.toolMeta : undefined,
    );
  } catch {
    // A tool without a valid UI declaration has no App to publish.
    return result;
  }
  const token = randomBytes(32).toString("base64url");
  // Only the owner fields the control keeps: never the credential subject.
  const {
    actorId,
    projectId,
    workspaceId,
    generation,
    serverId,
    bindingId,
    placement,
  } = source.owner;
  const owner = {
    actorId,
    projectId,
    workspaceId,
    instanceId: randomUUID(),
    generation,
    serverId,
    bindingId,
    placement,
  };
  try {
    const snapshotJson = JSON.stringify(
      modelAppControlSchema.parse({
        version: 1,
        kind: "model-app",
        expiresAt: input.expiresAt,
        instance: {
          owner,
          hostId: source.hostId,
          hostRevision: source.hostRevision,
          serverIdentity: source.serverIdentity,
          toolName: input.toolName,
          revision: input.revision,
          resourceUri,
        },
      }),
    );
    if (Buffer.byteLength(snapshotJson) > PLUGIN_INSTANCE_CONTROL_BYTES)
      throw new PluginInvocationError("INSTANCE_CONTROL_TOO_LARGE");
    const port = portFor(modelAppIdentity(source));
    if (!port) throw new PluginInvocationError("INSTANCE_STORE_UNAVAILABLE");
    await port.issue(
      token,
      {
        snapshotJson,
        ownerHash: pluginInvocationOwnerHash(owner, source.subject),
        expiresAt: input.expiresAt,
        contextToken: token,
        modelToken: token,
        modelThreadHash: pluginReceiptHash([
          "model-thread-v1",
          owner.workspaceId,
        ]),
      },
      input.signal,
    );
  } catch (error) {
    // The completed result stands and is recorded as is; only its App is
    // withheld. An unconfirmed issue may have stored a control, but no
    // marker names it, so it simply expires.
    logger.warn("Model App unavailable: its control was not stored", {
      code: error instanceof PluginInvocationError ? error.code : undefined,
    });
    return withMarker(result, { unavailable: true });
  }
  return withMarker(result, {
    instanceToken: token,
    projectId: source.owner.projectId,
    workspaceId: source.owner.workspaceId,
    hostId: source.hostId,
    serverId: source.owner.serverId,
  });
}
