import type { PluginWorkspaceDescriptor } from "@/shared/plugin-workspace";
import {
  PLUGIN_EXTENSION_CAPABILITY_KEYS,
  type PluginExtensionCapabilities,
} from "@/lib/client-config-v2-plugin-extensions";
import type { ThreadAppScope } from "./thread-app-api";

/**
 * Who owns extension state in the Playground.
 *
 * - The GLOBAL owner is keyed by user + project + client profile. It owns
 *   global Apps and their instance controls, survives chat switches, and
 *   closes when the project or client changes.
 * - A CHAT owner is keyed by user + project + client profile + chat. It owns
 *   thread Apps, file viewers, quick-action Apps, their context chips and
 *   pending forms. It is kept (hidden) when another chat is selected.
 *
 * Each owner has its own workspace ID, so instance controls, receipts and
 * grants follow the owner that opened the App.
 */
export interface ExtensionOwnerIdentity {
  actorId: string;
  projectId: string;
  /** Saved client profile (host) id. */
  hostId: string;
}

/** The global owner has no chat; activation requests still carry a thread id. */
export const GLOBAL_OWNER_THREAD_ID = "global";

export function ownerIdentityKey(
  identity: ExtensionOwnerIdentity | null | undefined,
): string | null {
  return identity
    ? JSON.stringify([identity.actorId, identity.projectId, identity.hostId])
    : null;
}

export function globalOwnerWorkspace(
  identity: ExtensionOwnerIdentity,
): PluginWorkspaceDescriptor {
  return {
    version: 1,
    workspaceId: `playground:${JSON.stringify([
      identity.actorId,
      identity.projectId,
      identity.hostId,
      "global",
    ])}`,
  };
}

export function chatOwnerWorkspace(
  identity: ExtensionOwnerIdentity,
  chatId: string,
): PluginWorkspaceDescriptor {
  return {
    version: 1,
    workspaceId: `playground:${JSON.stringify([
      identity.actorId,
      identity.projectId,
      identity.hostId,
      "chat",
      chatId,
    ])}`,
  };
}

/**
 * A compare lane is its own client with its own owner: one workspace per
 * user + project + client + lane + lane chat, never shared with the
 * single-chat Playground or another lane.
 */
export function compareLaneWorkspace(
  identity: ExtensionOwnerIdentity,
  kind: "host" | "model",
  laneId: string,
  chatId: string,
): PluginWorkspaceDescriptor {
  return {
    version: 1,
    workspaceId: `compare:${JSON.stringify([
      identity.actorId,
      identity.projectId,
      identity.hostId,
      kind,
      laneId,
      chatId,
    ])}`,
  };
}

export function globalOwnerScope(
  identity: ExtensionOwnerIdentity,
): ThreadAppScope {
  return {
    projectId: identity.projectId,
    hostId: identity.hostId,
    threadId: GLOBAL_OWNER_THREAD_ID,
    pluginWorkspace: globalOwnerWorkspace(identity),
  };
}

export function chatOwnerScope(
  identity: ExtensionOwnerIdentity,
  chatId: string,
): ThreadAppScope {
  return {
    projectId: identity.projectId,
    hostId: identity.hostId,
    threadId: chatId,
    pluginWorkspace: chatOwnerWorkspace(identity, chatId),
  };
}

/**
 * Per-extension switches: the client's "OpenAI plugin extensions" setting
 * (`mcpProfile.apps.pluginExtensions`, resolved by the SDK). Turning one off
 * removes only that capability: open Apps keep running.
 */
export type ExtensionCapabilities = PluginExtensionCapabilities;

export const ALL_EXTENSION_CAPABILITIES: ExtensionCapabilities = Object.freeze(
  Object.fromEntries(
    PLUGIN_EXTENSION_CAPABILITY_KEYS.map((key) => [key, true]),
  ) as ExtensionCapabilities,
);

/**
 * Tolerates a partial or missing setting: anything not explicitly `false` is
 * on, so a client profile saved before a toggle existed keeps today's behavior.
 */
export function resolveExtensionCapabilities(
  value: Partial<Record<keyof ExtensionCapabilities, unknown>> | null | undefined,
): ExtensionCapabilities {
  const resolved = { ...ALL_EXTENSION_CAPABILITIES };
  if (!value || typeof value !== "object") return resolved;
  for (const key of PLUGIN_EXTENSION_CAPABILITY_KEYS)
    if (value[key] === false) resolved[key] = false;
  return resolved;
}

export function capabilitiesKey(capabilities: ExtensionCapabilities): string {
  return PLUGIN_EXTENSION_CAPABILITY_KEYS.map((key) =>
    capabilities[key] ? "1" : "0",
  ).join("");
}
