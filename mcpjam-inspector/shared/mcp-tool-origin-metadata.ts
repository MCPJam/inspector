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
