import { createHash } from "node:crypto";
import {
  resolveToolUiResourceUri,
  stableStringifyJson,
} from "@mcpjam/sdk/widget-runtime";
import { PluginInvocationError } from "./invocation.js";
import { z } from "zod";

const bindingId = z.string().min(1).max(256);
export const pluginServerIdentitySchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("standalone"), serverId: bindingId }).strict(),
  z
    .object({
      kind: z.literal("plugin"),
      serverId: bindingId,
      pluginId: bindingId,
      pluginVersionId: bindingId,
      bundleHash: bindingId,
      componentKey: bindingId,
    })
    .strict(),
]);
export type PluginServerIdentity = z.infer<typeof pluginServerIdentitySchema>;

/** Ordinary MCP servers retain an explicit namespace, never a fictitious plugin version. */
export function pluginInstanceVersionId(
  identity: PluginServerIdentity | undefined,
  serverId: string,
  targetDigest: string,
) {
  return identity?.kind === "plugin"
    ? identity.pluginVersionId
    : `standalone:${serverId}:${targetDigest}`;
}

export const pluginBindingDigest = (value: unknown) => {
  if (value === undefined)
    throw new PluginInvocationError("INSTANCE_BINDING_UNAVAILABLE");
  // Preserve JSON representations such as URL.toJSON before canonical sorting.
  // The manager may hold URL objects; sorting their enumerable keys alone
  // would otherwise hash every URL as an empty object.
  return createHash("sha256")
    .update(stableStringifyJson(JSON.parse(JSON.stringify(value))))
    .digest("hex");
};
/** The App bridge permissions the request runtime recomputes on every request
 * (`appToolsEnabled`, `contextEnabled`, `messageEnabled`). */
const PER_REQUEST_APP_PERMISSIONS = [
  "serverTools",
  "updateModelContext",
  "message",
] as const;
const isPlainRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);

/**
 * The host half of an App's lifetime binding: `hostRevision`, and through it
 * the activation `bindingHash` and the pooled connection key.
 *
 * Rule: the binding names who hosts the App and how it runs (host, harness,
 * host style, execution scope and actor, Computer, protocol, sandbox and
 * model settings). A user-mutable permission leaves it only when every
 * request re-reads and enforces the CURRENT value, so changing it never
 * invalidates a retained App:
 *  - `mcpProfile.apps.pluginExtensions`, the client's OpenAI plugin extension
 *    toggles. A retained App's request refuses when the master switch is off,
 *    and each feature route refuses its own capability per request
 *    (`PLUGIN_EXTENSION_DISABLED`). Launcher toggles (sidebar Apps,
 *    conversation panels, file viewers) gate new opens only.
 *  - `mcpProfile.apps.mcpAppsOverrides.{serverTools,updateModelContext,message}`
 *    and `requireToolApproval`, recomputed by every request.
 *  - `hostConfigId`, the saved config's content address. It rotates on ANY
 *    saved edit, the toggles above included; the fields it summarizes are
 *    projected individually and stay bound.
 * Every other field is identity: changing it yields `INSTANCE_HOST_CHANGED`.
 * A config holding none of these hashes exactly as before, and containers
 * left empty are dropped, so saving a first toggle into an absent profile
 * doesn't change the digest either.
 */
export function pluginHostBindingDigest(config: unknown) {
  if (!isPlainRecord(config)) return pluginBindingDigest(config);
  const {
    hostConfigId: _contentAddress,
    requireToolApproval: _approval,
    ...bound
  } = config;
  const profile = bound.mcpProfile;
  if (isPlainRecord(profile)) {
    const next: Record<string, unknown> = { ...profile };
    if (isPlainRecord(profile.apps)) {
      const { pluginExtensions: _toggles, ...apps } = profile.apps;
      if (isPlainRecord(apps.mcpAppsOverrides)) {
        const overrides = { ...apps.mcpAppsOverrides };
        for (const key of PER_REQUEST_APP_PERMISSIONS) delete overrides[key];
        if (Object.keys(overrides).length) apps.mcpAppsOverrides = overrides;
        else delete apps.mcpAppsOverrides;
      }
      if (Object.keys(apps).length) next.apps = apps;
      else delete next.apps;
    }
    // A profile carrying nothing but its schema version is the default profile.
    if (Object.keys(next).every((key) => key === "profileVersion"))
      delete bound.mcpProfile;
    else bound.mcpProfile = next;
  }
  return pluginBindingDigest(bound);
}

/** Hash the authorized saved identity, never the connection's live credentials. */
export function pluginServerBindingDigest(value: unknown) {
  const identity = z
    .object({
      serverId: bindingId,
      credentialId: bindingId.nullable(),
      credentialAuthorizedAt: z.number().finite().nullable(),
      config: z
        .object({
          credentialConfigurationId: z.string().regex(/^[a-f0-9]{64}$/),
          transportType: z.enum(["http", "stdio"]),
        })
        .passthrough(),
    })
    .strict()
    .safeParse(value);
  if (!identity.success)
    throw new PluginInvocationError("INSTANCE_BINDING_UNAVAILABLE");
  const {
    headers: _headers,
    env: _env,
    timeout: _timeout,
    clientCapabilities: _capabilities,
    ...config
  } = identity.data.config;
  if (
    (identity.data.credentialId === null) !==
    (identity.data.credentialAuthorizedAt === null)
  )
    throw new PluginInvocationError("INSTANCE_BINDING_UNAVAILABLE");
  // OAuth discovery can be enabled for a server that needs no credential.
  // The fresh authorization result, not that preference, supplies the record.
  return pluginBindingDigest({ ...identity.data, config });
}
/** Only the actual catalog declares the preview's UI resource. */
export function pluginResourceUri(meta: Record<string, unknown> | undefined) {
  const effective = pluginOptionalResourceUri(meta);
  if (effective === undefined)
    throw new PluginInvocationError("INSTANCE_UI_UNAVAILABLE");
  return effective;
}

/** An ordinary tool can have no UI; a malformed declaration is never a plain tool. */
export function pluginOptionalResourceUri(
  meta: Record<string, unknown> | undefined,
) {
  const ui = meta?.ui;
  const uri =
    ui && typeof ui === "object"
      ? (ui as Record<string, unknown>).resourceUri
      : undefined;
  const effective =
    uri ?? resolveToolUiResourceUri(meta) ?? meta?.["openai/outputTemplate"];
  if (effective === undefined) return undefined;
  if (typeof effective !== "string" || !effective.startsWith("ui://")) {
    throw new PluginInvocationError("INSTANCE_UI_UNAVAILABLE");
  }
  return effective;
}
