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
import type { PluginSettingsActionBinding } from "./settings-catalog.js";
import {
  PluginSettingsError,
  parsePluginSettingsDocument,
  type PluginSettingsDocument,
} from "../../../shared/plugin-settings.js";
import {
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
