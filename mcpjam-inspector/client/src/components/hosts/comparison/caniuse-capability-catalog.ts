import {
  HOST_CONFIG_FIELDS,
  type HostComparisonSubject,
  type HostConfigFieldDef,
  type SupportLevel,
} from "@/lib/host-config-field-schema";
import type { HostListItem } from "@/hooks/useClients";
import {
  getSupportLevel,
  isSupportField,
} from "./support-level";
import type { HostConfigDtoV2 } from "@/lib/client-config-v2";

export const CANIUSE_LAST_VERIFIED_DATE = "2026-08-14";

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
  "clientInfo.name",
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

/** A public capability page can say "not yet measured" without treating it as a failure. */
export type CaniuseSupportLevel = SupportLevel | "unknown";

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
  // Labels are the raw custom-property names, so kebab-casing alone would
  // yield bare slugs like `color-text-primary` that could collide with a
  // future capability label. Namespace them.
  if (field.id.startsWith("styles.")) {
    return `style-${toKebab(field.label)}`;
  }
  return toKebab(field.label);
}

// Fields that are not support-shaped but still answer a compatibility
// question. They render as plain values (the matrix already knows how), so
// keep this list tiny — a chip says "can I use this", a value does not.
const PUBLIC_CAN_I_USE_PLAIN_FIELD_IDS = new Set([
  "supportedProtocolVersions",
  // Which build of the client the rest of the protocol rows were captured
  // from. A value, not a support claim — hence plain rather than a chip.
  "clientInfo.version",
]);

/**
 * Style variables are plain-value rows too, but there are 76 of them and they
 * arrive as a generated block, so they match by prefix rather than bloating the
 * id set above. Each shows the actual value the host sends — the point of the
 * subsection — which is why they are not support-shaped.
 */
const PUBLIC_CAN_I_USE_PLAIN_FIELD_PREFIXES = ["styles."];

export function isPublicCaniuseCapabilityField(
  field: HostConfigFieldDef,
): boolean {
  if (PUBLIC_CAN_I_USE_EXCLUDED_FIELD_IDS.has(field.id)) return false;
  if (isSupportField(field)) return true;
  if (PUBLIC_CAN_I_USE_PLAIN_FIELD_IDS.has(field.id)) return true;
  return PUBLIC_CAN_I_USE_PLAIN_FIELD_PREFIXES.some((prefix) =>
    field.id.startsWith(prefix),
  );
}

export const PUBLIC_CAN_I_USE_FIELDS: ReadonlyArray<HostConfigFieldDef> =
  HOST_CONFIG_FIELDS.filter(isPublicCaniuseCapabilityField);

/**
 * Whether any published host actually carries a value for this field.
 *
 * A row whose every column reads "Not yet tested" answers nothing — it
 * advertises a question we have not asked yet. Fields added ahead of their
 * measurements therefore stay hidden until the first real host value lands,
 * and appear on their own the moment one does. No allowlist to maintain: the
 * data decides.
 *
 * Only public presets (Claude, ChatGPT, Copilot, Cursor, Slack, VS Code) reach
 * these surfaces, so "a host that is not MCPJam" holds by construction — the
 * emulator's own defaults can never light a row on their own.
 */
export function caniuseFieldHasPresetData(
  field: HostConfigFieldDef,
  subjects: Record<string, HostComparisonSubject>,
): boolean {
  return Object.values(subjects).some(
    (subject) => field.read(subject.config) !== undefined,
  );
}

/** {@link PUBLIC_CAN_I_USE_FIELDS} minus the rows nobody has measured yet. */
export function publicCaniuseFieldsWithData(
  subjects: Record<string, HostComparisonSubject>,
): ReadonlyArray<HostConfigFieldDef> {
  return PUBLIC_CAN_I_USE_FIELDS.filter((field) =>
    caniuseFieldHasPresetData(field, subjects),
  );
}

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
): CaniuseSupportLevel {
  // These probe families were added after the catalog had shipped. An absent
  // value means we have not run that probe for this host yet — not that its
  // browser iframe, widget relay, or notification channel failed. Other
  // boolean rows retain their established absent = not supported semantics.
  if (
    (field.id.startsWith("toolResult.") ||
      field.id.startsWith("sandbox.browserStorage.") ||
      field.id.startsWith("toolListChanged.") ||
      // Enum rather than boolean, so it resolves to "neutral" rather than
      // undefined when unset — and "neutral" renders as "Not supported".
      // Without this an unprobed host publicly claims it cannot paginate.
      field.id === "paginationTraversal" ||
      // Same reasoning: once one host is measured the row appears, and the
      // hosts still queued behind it must read "Not yet tested" rather than
      // be published as silently abandoning every cancelled call.
      field.id === "toolCallCancellation") &&
    field.read(config) === undefined
  ) {
    return "unknown";
  }
  return getSupportLevel(field, config) ?? "unknown";
}

export function getCaniuseSupportLabel(level: CaniuseSupportLevel): string {
  switch (level) {
    case "supported":
      return "Supported";
    case "partial":
      return "Partial";
    case "neutral":
    case "unsupported":
      return "Not supported";
    case "unknown":
      return "Not yet tested";
  }
}
