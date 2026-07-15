import {
  HOST_CONFIG_FIELDS,
  type HostConfigFieldDef,
  type SupportLevel,
} from "@/lib/host-config-field-schema";
import type { HostListItem } from "@/hooks/useClients";
import {
  getSupportLevel,
  isSupportField,
} from "./support-level";
import type { HostConfigDtoV2 } from "@/lib/client-config-v2";

export const CANIUSE_LAST_VERIFIED_DATE = "2026-07-07";

export const PUBLIC_CAN_I_USE_INLINE_PRESET_IDS = [
  "preset:claude",
  "preset:chatgpt",
  "preset:copilot",
  "preset:cursor",
  "preset:slack",
  "preset:vscode",
] as const;

const PUBLIC_CAN_I_USE_EXCLUDED_FIELD_IDS = new Set([
  "modelId",
  "temperature",
  "systemPrompt",
  "mcpProtocolVersion",
  "supportedProtocolVersions",
  "clientInfo.name",
  "clientInfo.version",
  "connectionDefaults.requestTimeout",
  "connectionDefaults.headers",
  "uiInitialize.hostInfo",
  "sandbox.csp.mode",
  "sandbox.permissions.mode",
  "sandbox.sandboxAttrs",
  "sandbox.allowFeatures",
]);

export interface CaniuseCapability {
  slug: string;
  field: HostConfigFieldDef;
}

function toKebab(input: string): string {
  return input
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function slugForField(field: HostConfigFieldDef): string {
  if (field.id.startsWith("capabilities.")) {
    return toKebab(field.id.replace(/^capabilities\./, ""));
  }
  if (field.id.startsWith("appsCap.")) {
    return `mcp-apps-${toKebab(field.label)}`;
  }
  if (field.id.startsWith("openaiShim.")) {
    return `openai-shim-${toKebab(field.label)}`;
  }
  if (field.id.startsWith("sandboxPerm.")) {
    return `sandbox-permission-${toKebab(field.label)}`;
  }
  return toKebab(field.label);
}

export function isPublicCaniuseCapabilityField(
  field: HostConfigFieldDef,
): boolean {
  return (
    isSupportField(field) && !PUBLIC_CAN_I_USE_EXCLUDED_FIELD_IDS.has(field.id)
  );
}

export const PUBLIC_CAN_I_USE_FIELDS: ReadonlyArray<HostConfigFieldDef> =
  HOST_CONFIG_FIELDS.filter(isPublicCaniuseCapabilityField);

export const CANIUSE_CAPABILITIES: ReadonlyArray<CaniuseCapability> =
  PUBLIC_CAN_I_USE_FIELDS.map((field) => ({
    slug: slugForField(field),
    field,
  }));

const capabilitiesBySlug = new Map<string, CaniuseCapability>();
const capabilitiesByFieldId = new Map<string, CaniuseCapability>();
for (const capability of CANIUSE_CAPABILITIES) {
  const duplicate = capabilitiesBySlug.get(capability.slug);
  if (duplicate) {
    throw new Error(
      `Duplicate caniuse capability slug "${capability.slug}" for ${duplicate.field.id} and ${capability.field.id}`,
    );
  }
  capabilitiesBySlug.set(capability.slug, capability);
  capabilitiesByFieldId.set(capability.field.id, capability);
}

export function getCaniuseCapabilityBySlug(
  slug: string | null | undefined,
): CaniuseCapability | null {
  if (!slug) return null;
  return capabilitiesBySlug.get(slug) ?? null;
}

export function getCaniuseCapabilityForField(
  field: HostConfigFieldDef,
): CaniuseCapability | null {
  return capabilitiesByFieldId.get(field.id) ?? null;
}

export function buildCaniuseCapabilityPath(slug: string): string {
  return `/capabilities/${encodeURIComponent(slug)}`;
}

export function sortCaniusePresetHosts<T extends Pick<HostListItem, "hostId">>(
  hosts: ReadonlyArray<T>,
): T[] {
  const rank = new Map<string, number>(
    PUBLIC_CAN_I_USE_INLINE_PRESET_IDS.map((hostId, index) => [hostId, index]),
  );
  return [...hosts].sort((a, b) => {
    const aRank = rank.get(a.hostId) ?? Number.POSITIVE_INFINITY;
    const bRank = rank.get(b.hostId) ?? Number.POSITIVE_INFINITY;
    return aRank - bRank;
  });
}

export function getCaniuseSupportLevel(
  field: HostConfigFieldDef,
  config: HostConfigDtoV2,
): SupportLevel {
  return getSupportLevel(field, config) ?? "neutral";
}

export function getCaniuseSupportLabel(level: SupportLevel): string {
  switch (level) {
    case "supported":
      return "Supported";
    case "partial":
      return "Partial";
    case "neutral":
    case "unsupported":
      return "Not supported";
  }
}
