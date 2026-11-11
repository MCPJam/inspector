import { randomBytes } from "node:crypto";
import { z } from "zod";
import {
  createPluginInstanceControlPort,
  type PluginInstanceControlPort,
} from "./instance-store.js";
import {
  pluginInstances,
  type PluginInstanceIdentity,
  type PluginPreviewInstance,
} from "./instances.js";
import { PluginInvocationError } from "./invocation.js";
import { pluginInvocationOwnerHash, pluginReceiptHash } from "./receipt-store.js";
import type { PluginSettingsActionBinding } from "./settings-catalog.js";
import {
  PluginSettingsError,
  parsePluginSettingsDocument,
  type PluginSettingsDocument,
} from "../../../shared/plugin-settings.js";
import {
  INVOCATION_RECEIPT_TTL_MS,
  PLUGIN_SETTINGS_CONTROL_BYTES,
  type DurablePluginInstanceControl,
} from "../../../shared/plugin-invocation-receipts.js";

/**
 * What a Settings App's row keeps, so whichever replica serves its next step
 * has it: the plugin's own settings read result, parsed again with the same
 * strict parser on every use, and the actions a Settings App child is
 * admitted against. A save's values are not written back: nothing on the
 * server reads them, and the client shows the save's own result.
 */
const envelopeSchema = z.strictObject({
  version: z.literal(1),
  document: z.unknown(),
  actions: z.array(
    z.strictObject({
      kind: z.enum(["tool", "app", "unavailable"]),
      name: z.string(),
      title: z.string(),
      revision: z.string(),
    }),
  ),
  schemaChanged: z.literal(true).optional(),
});
export type PluginSettingsEnvelope = z.infer<typeof envelopeSchema>;

export type PluginSettingsState = {
  instance: PluginPreviewInstance;
  /** The row's current lease; a Settings App child never outlives it. */
  expiresAt: number;
  /** The row's settings version; undefined when the row has no slot. */
  version: number | undefined;
  /** The document the last settings read stored, if one has. */
  document: PluginSettingsDocument | undefined;
};

export function parsePluginSettingsEnvelope(settingsJson: string) {
  const envelope = envelopeSchema.parse(JSON.parse(settingsJson));
  return {
    envelope,
    document: parsePluginSettingsDocument(envelope.document),
  };
}

/** A control port that remembers the last control it read. */
function observedPort(actor: PluginInstanceIdentity) {
  const port = createPluginInstanceControlPort(actor);
  if (!port) throw new PluginInvocationError("INSTANCE_STORE_UNAVAILABLE");
  const seen: { control: DurablePluginInstanceControl | null } = {
    control: null,
  };
  const observed: PluginInstanceControlPort = {
    ...port,
    read: async (...args) => (seen.control = await port.read(...args)),
  };
  return { port, observed, seen };
}

/** Restore a Settings App and the document its row holds, from this
 * request's own read: a copy this replica cached may be older. */
export async function readPluginSettingsState(
  token: string,
  actor: PluginInstanceIdentity,
  signal: AbortSignal,
): Promise<PluginSettingsState> {
  const { observed, seen } = observedPort(actor);
  const instance = await pluginInstances.getPersistent(
    token,
    actor,
    signal,
    observed,
  );
  const version = seen.control?.settingsVersion;
  const settingsJson = seen.control?.settingsJson;
  return {
    instance,
    expiresAt: seen.control?.expiresAt ?? 0,
    version,
    document: settingsJson
      ? parsePluginSettingsEnvelope(settingsJson).document
      : undefined,
  };
}

/** Keep the document a settings read just returned, for every replica's next
 * step. The read fails when it cannot be kept: otherwise the next save would
 * be refused wherever this replica's memory is not. */
export async function storePluginSettingsDocument(
  token: string,
  actor: PluginInstanceIdentity,
  version: number | undefined,
  document: unknown,
  actions: readonly PluginSettingsActionBinding[],
  signal: AbortSignal,
) {
  const port = createPluginInstanceControlPort(actor);
  if (!port?.writeSettings)
    throw new PluginInvocationError("INSTANCE_STORE_UNAVAILABLE");
  // A row without the slot was opened by an older Inspector: reopening gives
  // the Settings App a row that has one.
  if (version === undefined)
    throw new PluginInvocationError("INSTANCE_UNAVAILABLE");
  const envelope: PluginSettingsEnvelope = {
    version: 1,
    document,
    actions: actions.map(({ kind, name, title, revision }) => ({
      kind,
      name,
      title,
      revision,
    })),
  };
  const settingsJson = JSON.stringify(envelope);
  if (Buffer.byteLength(settingsJson) > PLUGIN_SETTINGS_CONTROL_BYTES)
    throw new PluginSettingsError("PLUGIN_SETTINGS_LIMIT");
  try {
    await port.writeSettings(token, { expectedVersion: version, settingsJson }, signal);
  } catch (error) {
    if (
      !(error instanceof PluginInvocationError) ||
      error.code !== "SETTINGS_CONTROL_CONFLICT"
    )
      throw error;
    // Another read of this Settings App stored first. Both are fresh reads of
    // the same plugin, so this one is written once more at the version that
    // read left.
    const current = await readPluginSettingsState(token, actor, signal);
    if (current.version === undefined) throw error;
    await port.writeSettings(
      token,
      { expectedVersion: current.version, settingsJson },
      signal,
    );
  }
}

/** What a Settings App child's row records: which Settings App opened it, and
 * for which App action at which revision. */
const childSnapshotSchema = z.strictObject({
  kind: z.literal("settings-child"),
  version: z.literal(1),
  parentInstanceId: z.string(),
  parentGeneration: z.number().int(),
  action: z.string(),
  revision: z.string(),
  resourceUri: z.string(),
});
export type PluginSettingsChild = z.infer<typeof childSnapshotSchema>;

/** Open an App from a Settings App action as a row of its own, so any replica
 * can serve its calls. The backend admits it only while the Settings App
 * lives and its stored document lists the action at this revision. */
export async function issuePluginSettingsChild(
  token: string,
  actor: PluginInstanceIdentity,
  state: Pick<PluginSettingsState, "instance" | "expiresAt">,
  app: { action: string; revision: string; resourceUri: string },
  signal: AbortSignal,
) {
  const port = createPluginInstanceControlPort(actor);
  if (!port?.issueChild)
    throw new PluginInvocationError("INSTANCE_STORE_UNAVAILABLE");
  const childToken = randomBytes(32).toString("base64url");
  const snapshot: PluginSettingsChild = {
    kind: "settings-child",
    version: 1,
    parentInstanceId: state.instance.owner.instanceId,
    parentGeneration: state.instance.owner.generation,
    ...app,
  };
  const issued = await port.issueChild(
    childToken,
    {
      // Each open is its own App; a lost reply leaves an unused row that
      // expires with the Settings App.
      childAnchorHash: pluginReceiptHash(["settings-child-anchor", childToken]),
      childParentOwnerHash: pluginInvocationOwnerHash(
        state.instance.owner,
        actor.subject,
      ),
      childParentScopeHash: pluginReceiptHash(["settings-child-scope", token]),
      // Apps one Settings App opens for the same action share one quota.
      childSourceHash: pluginReceiptHash(["settings-child-source", token, app.action]),
      childBindingHash: pluginReceiptHash(["settings-child-binding", snapshot]),
      childSettingsAction: { name: app.action, revision: app.revision },
      ownerHash: pluginReceiptHash(["settings-child-owner", childToken]),
      snapshotJson: JSON.stringify(snapshot),
      expiresAt: Math.min(
        state.expiresAt,
        Date.now() + INVOCATION_RECEIPT_TTL_MS,
      ),
    },
    signal,
  );
  return issued.token;
}

/** Read a Settings App child for the Settings App that opened it. Its row is
 * gone once the child or the Settings App closes, expires, or the action
 * leaves the stored document. */
export async function readPluginSettingsChild(
  childToken: string,
  actor: PluginInstanceIdentity,
  parent: PluginPreviewInstance,
  signal: AbortSignal,
): Promise<PluginSettingsChild> {
  const port = createPluginInstanceControlPort(actor);
  if (!port) throw new PluginInvocationError("INSTANCE_STORE_UNAVAILABLE");
  const control = await port.read(childToken, signal);
  if (!control) throw new PluginInvocationError("INSTANCE_UNAVAILABLE");
  const child = childSnapshotSchema.parse(JSON.parse(control.snapshotJson));
  if (
    child.parentInstanceId !== parent.owner.instanceId ||
    child.parentGeneration !== parent.owner.generation
  )
    throw new PluginInvocationError("INSTANCE_DENIED");
  return child;
}

export async function closePluginSettingsChild(
  childToken: string,
  actor: PluginInstanceIdentity,
  signal: AbortSignal,
) {
  const port = createPluginInstanceControlPort(actor);
  if (!port) throw new PluginInvocationError("INSTANCE_STORE_UNAVAILABLE");
  await port.close(childToken, signal);
}
