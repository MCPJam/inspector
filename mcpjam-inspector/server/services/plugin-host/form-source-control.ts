import { z } from "zod";
import {
  PLUGIN_INSTANCE_CONTROL_BYTES,
  type DurablePluginInstanceControl,
} from "../../../shared/plugin-invocation-receipts.js";
import { pluginBindingDigest } from "./bindings.js";
import type { PluginFormSource } from "./form-sources.js";
import type { PluginInstanceIdentity } from "./instances.js";
import {
  PLUGIN_INVOCATION_ORIGINS,
  PluginInvocationError,
} from "./invocation.js";
import {
  pluginInstanceIdentityHash,
  type PluginInstanceControlPort,
} from "./instance-store.js";
import {
  createPluginInvocationReceiptPort,
  pluginReceiptHash,
} from "./receipt-store.js";

const id = z.string().min(1).max(4096);
const token = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
/** The row that owns a form: an App, a model App or a suspended model call.
 * Another replica restores the owner from it to serve the form's requests. */
export const pluginFormOwnerRefSchema = z.strictObject({
  kind: z.enum(["app", "model-app", "model-form"]),
  token,
});
export type PluginFormOwnerRef = z.infer<typeof pluginFormOwnerRefSchema>;

/**
 * An MRTR form source, in the form every replica restores. It keeps the schema's
 * digest, not the schema: the schema is in the call's receipt (its suspended
 * leg), and a small row keeps the store's per-person scans small.
 */
const formSourceControlSchema = z.strictObject({
  version: z.literal(1),
  kind: z.literal("form-source"),
  expiresAt: z.number().int().positive(),
  ownerRef: pluginFormOwnerRefSchema,
  source: z.strictObject({
    owner: z.strictObject({
      actorId: id,
      projectId: id,
      workspaceId: id,
      instanceId: id,
      generation: z.number().int().positive(),
      serverId: id,
      bindingId: id,
      placement: z.enum(["interactive", "ephemeral-run"]),
      runId: id.optional(),
    }),
    hostId: id,
    hostRevision: id,
    invocationId: z.string().min(1).max(128),
    origin: z.enum(PLUGIN_INVOCATION_ORIGINS),
    revision: id,
    toolName: id,
    parent: z.strictObject({
      kind: z.literal("mrtr"),
      id: z.string().min(1).max(4096),
      round: z.number().int().positive(),
      inputRequestKey: z.string().min(1).max(4096),
    }),
    schemaDigest: z.string().regex(/^[0-9a-f]{64}$/),
    uploadTarget: z.enum(["local-stdio", "computer"]).optional(),
    fileResources: z.boolean().optional(),
  }),
});
type FormSourceControl = z.infer<typeof formSourceControlSchema>;

/** Each row's own owner hash, never a receipt's: a closed form row must not
 * fence the call's receipts. */
export const pluginControlOwnerHash = (
  kind: string,
  identity: PluginInstanceIdentity,
  rowToken: string,
) =>
  pluginReceiptHash([
    "plugin-control-owner-v1",
    kind,
    pluginInstanceIdentityHash(identity),
    rowToken,
  ]);

const unavailable = () => new PluginInvocationError("FORM_SOURCE_UNAVAILABLE");

/** Store an MRTR form source before its token reaches the browser. */
export async function storeFormSource(
  port: PluginInstanceControlPort,
  rowToken: string,
  identity: PluginInstanceIdentity,
  source: PluginFormSource,
  ownerRef: PluginFormOwnerRef,
  signal: AbortSignal,
) {
  if (source.parent.kind !== "mrtr") throw unavailable();
  const { requestedSchema, expiresAt, ...rest } = source;
  // A JSON round trip drops absent optional fields, which the strict schema
  // would otherwise see as keys.
  const snapshotJson = JSON.stringify(
    formSourceControlSchema.parse(
      JSON.parse(
        JSON.stringify({
          version: 1,
          kind: "form-source",
          expiresAt,
          ownerRef,
          source: { ...rest, schemaDigest: pluginBindingDigest(requestedSchema) },
        }),
      ),
    ),
  );
  if (Buffer.byteLength(snapshotJson) > PLUGIN_INSTANCE_CONTROL_BYTES)
    throw new PluginInvocationError("INSTANCE_CONTROL_TOO_LARGE");
  await port.issue(
    rowToken,
    {
      snapshotJson,
      ownerHash: pluginControlOwnerHash("form-source", identity, rowToken),
      expiresAt: source.expiresAt,
    },
    signal,
  );
}

/** A stored form source, or undefined for any other kind of row. */
export function parseFormSource(saved: DurablePluginInstanceControl) {
  let value: unknown;
  try {
    value = JSON.parse(saved.snapshotJson);
  } catch {
    return undefined;
  }
  const parsed = formSourceControlSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

/**
 * The schema a stored source was bound with, from the call's own receipt:
 * the suspended leg that showed this round holds the pending form. Checked
 * against the row's digest, so neither copy can stand in for the other.
 */
export async function readFormSourceSchema(
  row: FormSourceControl,
  identity: PluginInstanceIdentity,
  signal: AbortSignal,
) {
  const receipts = createPluginInvocationReceiptPort(
    row.source.owner,
    identity.subject,
  );
  if (!receipts) throw unavailable();
  const saved = await receipts.read(row.source.invocationId, signal);
  const leg = saved?.legs.find(
    (candidate) =>
      candidate.state === "suspended" &&
      candidate.continuationId === row.source.parent.id &&
      candidate.pendingRound === row.source.parent.round,
  );
  if (!leg?.valueJson) throw unavailable();
  const pending = JSON.parse(leg.valueJson) as {
    inputRequests?: { key?: unknown; requestedSchema?: unknown }[];
  };
  const request = pending.inputRequests?.find(
    (candidate) => candidate.key === row.source.parent.inputRequestKey,
  );
  if (
    !request ||
    pluginBindingDigest(request.requestedSchema) !== row.source.schemaDigest
  )
    throw unavailable();
  return request.requestedSchema;
}

/** The full source a stored row describes, given its verified schema. */
export function formSourceFromRow(
  row: FormSourceControl,
  requestedSchema: unknown,
): PluginFormSource {
  const { schemaDigest: _digest, ...source } = row.source;
  return { ...source, requestedSchema, expiresAt: row.expiresAt };
}
export type StoredFormSource = FormSourceControl;
