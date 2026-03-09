/**
 * Shared helpers for reading metadata and server IDs from tool results.
 *
 * Tool results may carry `_meta` and `_serverId` either at the top level
 * or nested under a `.value` wrapper. These utilities normalise access
 * across both shapes.
 */

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

export function readToolResultObject(
  result: unknown,
): Record<string, unknown> | undefined {
  if (!isRecord(result)) return undefined;
  return result;
}

export function readToolResultMeta(
  result: unknown,
): Record<string, unknown> | undefined {
  if (!isRecord(result)) return undefined;

  if (isRecord(result._meta)) {
    return result._meta;
  }

  if (isRecord(result.value) && isRecord(result.value._meta)) {
    return result.value._meta;
  }

  return undefined;
}

export function readToolResultServerId(result: unknown): string | undefined {
  if (!isRecord(result)) return undefined;

  if (typeof result._serverId === "string") {
    return result._serverId;
  }

  if (isRecord(result.value) && typeof result.value._serverId === "string") {
    return result.value._serverId;
  }

  const meta = readToolResultMeta(result);
  return typeof meta?._serverId === "string" ? meta._serverId : undefined;
}
