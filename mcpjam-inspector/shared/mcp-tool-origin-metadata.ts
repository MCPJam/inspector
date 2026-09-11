import type { JSONObject, JSONValue } from "@ai-sdk/provider";

const MCPJAM_PROVIDER_METADATA_KEY = "mcpjam";

export type McpToolOriginProviderMetadata = Record<string, JSONObject>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isJsonValue(value: unknown): value is JSONValue {
  if (value === null) return true;
  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return true;
  }
  if (Array.isArray(value)) return value.every(isJsonValue);
  return isJsonObject(value);
}

function isJsonObject(value: unknown): value is JSONObject {
  if (!isRecord(value)) return false;
  return Object.values(value).every(
    (entry) => entry === undefined || isJsonValue(entry)
  );
}

function toProviderMetadata(
  metadata: unknown
): McpToolOriginProviderMetadata {
  if (!isRecord(metadata)) return {};
  const out: McpToolOriginProviderMetadata = {};
  for (const [key, value] of Object.entries(metadata)) {
    if (isJsonObject(value)) {
      out[key] = value;
    }
  }
  return out;
}

export function readMcpToolOriginServerId(
  metadata: unknown
): string | undefined {
  if (!isRecord(metadata)) return undefined;
  const mcpjam = metadata[MCPJAM_PROVIDER_METADATA_KEY];
  if (!isRecord(mcpjam)) return undefined;
  const serverId = mcpjam.serverId;
  return typeof serverId === "string" && serverId.length > 0
    ? serverId
    : undefined;
}

export function mergeMcpToolOriginMetadata(
  metadata: unknown,
  serverId: string | undefined
): McpToolOriginProviderMetadata | undefined {
  const base = toProviderMetadata(metadata);
  if (!serverId) {
    return Object.keys(base).length > 0 ? base : undefined;
  }

  const existingMcpjam = isJsonObject(base[MCPJAM_PROVIDER_METADATA_KEY])
    ? base[MCPJAM_PROVIDER_METADATA_KEY]
    : {};
  return {
    ...base,
    [MCPJAM_PROVIDER_METADATA_KEY]: {
      ...existingMcpjam,
      serverId,
    },
  };
}

export function stripMcpToolOriginMetadata(
  metadata: unknown
): McpToolOriginProviderMetadata | undefined {
  const copy = toProviderMetadata(metadata);
  delete copy[MCPJAM_PROVIDER_METADATA_KEY];
  return Object.keys(copy).length > 0 ? copy : undefined;
}

/**
 * The document generation a `webmcp_*` call was minted against, as it rides
 * the tool-call part.
 *
 * WHY IT RIDES THE TOOL CALL. An approval pauses the turn and resumes in a
 * NEW request, whose tool set is rebuilt from the page as it is THEN. The
 * tool the model called and the tool that now carries its name can be two
 * different registrations — a reload re-registers, a navigation replaces —
 * and the approved arguments would run against the second. The binding the
 * call was decided from has to travel with the call; the tool-call part's
 * provider metadata is the one field the AI SDK carries server → client →
 * server unchanged (`callProviderMetadata` ⇄ `providerOptions`), and it is
 * already the channel the MCP server id uses above.
 */
export interface PageToolBindingMetadata {
  bootId: string;
  tabId: string;
  navCounter: number;
  frameId: string;
  registrationSeq: number;
}

const PAGE_TOOL_BINDING_KEY = "pageToolBinding";

export function readPageToolBinding(
  metadata: unknown
): PageToolBindingMetadata | undefined {
  if (!isRecord(metadata)) return undefined;
  const mcpjam = metadata[MCPJAM_PROVIDER_METADATA_KEY];
  if (!isRecord(mcpjam)) return undefined;
  const binding = mcpjam[PAGE_TOOL_BINDING_KEY];
  if (!isRecord(binding)) return undefined;
  const { bootId, tabId, navCounter, frameId, registrationSeq } = binding;
  if (
    typeof bootId !== "string" ||
    typeof tabId !== "string" ||
    typeof navCounter !== "number" ||
    typeof frameId !== "string" ||
    typeof registrationSeq !== "number"
  ) {
    return undefined;
  }
  return { bootId, tabId, navCounter, frameId, registrationSeq };
}

/**
 * Record the binding on a tool call's metadata — ONLY IF NONE IS THERE.
 *
 * A part that already carries one is a call from an earlier request, and the
 * binding it carries is the one the person approved against. Overwriting it
 * with the current tool's would make the comparison in the tool's `execute`
 * always succeed, which is the substitution it exists to refuse.
 */
export function mergePageToolBindingMetadata(
  metadata: unknown,
  binding: PageToolBindingMetadata | undefined
): McpToolOriginProviderMetadata | undefined {
  const base = toProviderMetadata(metadata);
  if (!binding || readPageToolBinding(base)) {
    return Object.keys(base).length > 0 ? base : undefined;
  }
  const existingMcpjam = isJsonObject(base[MCPJAM_PROVIDER_METADATA_KEY])
    ? base[MCPJAM_PROVIDER_METADATA_KEY]
    : {};
  return {
    ...base,
    [MCPJAM_PROVIDER_METADATA_KEY]: {
      ...existingMcpjam,
      [PAGE_TOOL_BINDING_KEY]: { ...binding },
    },
  };
}

export function samePageToolBinding(
  a: PageToolBindingMetadata,
  b: PageToolBindingMetadata
): boolean {
  return (
    a.bootId === b.bootId &&
    a.tabId === b.tabId &&
    a.navCounter === b.navCounter &&
    a.frameId === b.frameId &&
    a.registrationSeq === b.registrationSeq
  );
}
