/**
 * Per-client "OpenAI plugin extensions" setting
 * (`mcpProfile.apps.pluginExtensions`): the inspector-side helpers.
 *
 * Resolution lives in the SDK (`resolvePluginExtensions`) so the client and
 * the server answer "is this extension on for this client?" the same way.
 * This module adds the editor setters, UI labels, and the gate the
 * Playground reads instead of the client's visual style family.
 */

import {
  PLUGIN_EXTENSION_CAPABILITY_KEYS,
  pluginExtensionsDefaultEnabled,
  readPluginExtensionsSetting,
  resolvePluginExtensions,
  type HostConfigPluginExtensionsV1,
  type PluginExtensionCapabilities,
  type PluginExtensionCapabilityKey,
  type ResolvedPluginExtensions,
} from "@mcpjam/sdk/host-config/internal";
import {
  isMcpProfileEmpty,
  type HostConfigInputV2,
  type HostConfigMcpProfileV1,
} from "@/lib/client-config-v2";

export {
  PLUGIN_EXTENSION_CAPABILITY_KEYS,
  pluginExtensionsDefaultEnabled,
  resolvePluginExtensions,
};
export type {
  PluginExtensionCapabilities,
  PluginExtensionCapabilityKey,
  ResolvedPluginExtensions,
};

/** The host fields the resolver reads. Accepts a DTO, an input, or a draft. */
export type PluginExtensionsHostConfig = {
  hostStyle?: string | null;
  harness?: string | null;
  mcpProfile?: HostConfigMcpProfileV1 | Record<string, unknown> | null;
};

/**
 * The gate every extension surface reads: `enabled` is the master switch
 * (after the client style default), `capabilities` each extension's state.
 * A missing host config resolves to everything off.
 */
export function pluginExtensionsForHost(
  hostConfig: PluginExtensionsHostConfig | null | undefined,
): ResolvedPluginExtensions {
  return resolvePluginExtensions(hostConfig ?? undefined);
}

/** Everything off — used while a gate can't be resolved (loading, error). */
export const PLUGIN_EXTENSIONS_OFF: ResolvedPluginExtensions = Object.freeze({
  enabled: false,
  explicit: false,
  capabilities: Object.freeze(
    Object.fromEntries(
      PLUGIN_EXTENSION_CAPABILITY_KEYS.map((key) => [key, false]),
    ),
  ) as PluginExtensionCapabilities,
}) as ResolvedPluginExtensions;

export const PLUGIN_EXTENSION_CAPABILITY_LABELS: ReadonlyArray<{
  key: PluginExtensionCapabilityKey;
  label: string;
  description: string;
}> = [
  {
    key: "sidebarApps",
    label: "Sidebar Apps",
    description: "Global Apps that open from the sidebar",
  },
  {
    key: "conversationPanels",
    label: "Conversation panels",
    description: "Apps that open beside a conversation",
  },
  {
    key: "fileViewers",
    label: "File viewers",
    description: "Apps that open a file from Open with",
  },
  {
    key: "fileResources",
    label: "File resources",
    description: "Apps read the file they were opened with",
  },
  {
    key: "localFiles",
    label: "Opening local files",
    description: "Apps ask the client to open a file by path",
  },
  {
    key: "settings",
    label: "Settings",
    description: "Server settings in the server's details",
  },
  {
    key: "displayModes",
    label: "Display modes",
    description: "Apps switch between inline, panel and fullscreen",
  },
  {
    key: "deepLinks",
    label: "Deep links",
    description: "Links that open a plugin's App",
  },
  {
    key: "modelContext",
    label: "Model context",
    description: "Apps add context chips for the model",
  },
  {
    key: "messages",
    label: "Messages",
    description: "Apps send messages to the conversation",
  },
  {
    key: "mentions",
    label: "Mentions",
    description: "@ search across a plugin's resources",
  },
  { key: "forms", label: "Forms", description: "Rich forms in the composer" },
  {
    key: "onboarding",
    label: "Onboarding",
    description: "Run a plugin's onboarding skill",
  },
];

function withPluginExtensions(
  prev: HostConfigInputV2,
  next: HostConfigPluginExtensionsV1 | undefined,
): HostConfigInputV2 {
  const base: HostConfigMcpProfileV1 = prev.mcpProfile ?? { profileVersion: 1 };
  const apps = { ...(base.apps ?? {}) };
  if (next === undefined) delete apps.pluginExtensions;
  else apps.pluginExtensions = next;
  const updated: HostConfigMcpProfileV1 = {
    ...base,
    apps: Object.keys(apps).length > 0 ? apps : undefined,
  };
  // Collapse to absence like every Apps-tab setter, so an untouched profile
  // doesn't mint a new config hash.
  return {
    ...prev,
    mcpProfile: isMcpProfileEmpty(updated) ? undefined : updated,
  };
}

/**
 * Master switch. Turning it off clears per-extension choices (they mean
 * nothing while everything is off). Off on a style whose default is already
 * off collapses to "not set", so a Cursor client that never opted in keeps
 * its original config hash.
 */
export function setPluginExtensionsEnabledOnDraft(
  prev: HostConfigInputV2,
  enabled: boolean,
): HostConfigInputV2 {
  const current = readPluginExtensionsSetting(prev.mcpProfile);
  if (!enabled && !pluginExtensionsDefaultEnabled(prev)) {
    return withPluginExtensions(prev, undefined);
  }
  if (!enabled) return withPluginExtensions(prev, { enabled: false });
  const capabilities = current?.capabilities ?? {};
  return withPluginExtensions(
    prev,
    Object.keys(capabilities).length > 0
      ? { enabled: true, capabilities }
      : { enabled: true },
  );
}

/**
 * One extension. Only switched-off extensions are stored; switching one on
 * removes its entry. Switching an extension on while the master switch is
 * off also turns the master switch on, with every other extension off.
 */
export function setPluginExtensionCapabilityOnDraft(
  prev: HostConfigInputV2,
  key: PluginExtensionCapabilityKey,
  enabled: boolean,
): HostConfigInputV2 {
  const resolved = resolvePluginExtensions(prev);
  const current = readPluginExtensionsSetting(prev.mcpProfile);
  let capabilities: Partial<Record<PluginExtensionCapabilityKey, boolean>>;
  if (!resolved.enabled) {
    if (!enabled) return prev;
    capabilities = Object.fromEntries(
      PLUGIN_EXTENSION_CAPABILITY_KEYS.filter((k) => k !== key).map((k) => [
        k,
        false,
      ]),
    );
  } else {
    capabilities = { ...(current?.capabilities ?? {}) };
    if (enabled) delete capabilities[key];
    else capabilities[key] = false;
  }
  return withPluginExtensions(
    prev,
    Object.keys(capabilities).length > 0
      ? { enabled: true, capabilities }
      : { enabled: true },
  );
}

/**
 * App-facing capabilities an instance handle grants, narrowed to the
 * client's per-extension toggles. Generic over the handle so it can be
 * applied wherever a thread/global/file App handle is composed into a host;
 * fields the toggles don't govern pass through untouched.
 */
export function maskPluginAppHandle<
  T extends {
    contextEnabled?: boolean;
    messageEnabled?: boolean;
    localFilesAvailable?: boolean;
    deepLinkNamespace?: unknown;
  },
>(handle: T, resolved: Pick<ResolvedPluginExtensions, "capabilities">): T {
  const { capabilities } = resolved;
  const next = { ...handle };
  if (!capabilities.modelContext && next.contextEnabled)
    next.contextEnabled = false;
  if (!capabilities.messages && next.messageEnabled)
    next.messageEnabled = false;
  if (!capabilities.localFiles && next.localFilesAvailable)
    next.localFilesAvailable = false;
  if (!capabilities.deepLinks && next.deepLinkNamespace !== undefined)
    delete next.deepLinkNamespace;
  return next;
}

/**
 * Strip App-facing `experimental["openai/*"]` claims the client's toggles
 * switched off. Apply to the result of `resolveEffectiveHostCapabilities`
 * after the extension host adds its keys.
 */
export function filterOpenAiHostCapabilities<
  T extends { experimental?: Record<string, unknown> },
>(capabilities: T, resolved: Pick<ResolvedPluginExtensions, "capabilities">): T {
  const experimental = capabilities.experimental;
  if (!experimental) return capabilities;
  const blocked = new Set<string>();
  if (!resolved.capabilities.modelContext) blocked.add("openai/modelContext");
  if (!resolved.capabilities.messages) blocked.add("openai/message");
  if (!resolved.capabilities.fileResources) blocked.add("openai/resource");
  if (!resolved.capabilities.localFiles) blocked.add("openai/files");
  if (![...blocked].some((key) => key in experimental)) return capabilities;
  const kept = Object.fromEntries(
    Object.entries(experimental).filter(([key]) => !blocked.has(key)),
  );
  const next = { ...capabilities };
  if (Object.keys(kept).length > 0) next.experimental = kept;
  else delete next.experimental;
  return next;
}
