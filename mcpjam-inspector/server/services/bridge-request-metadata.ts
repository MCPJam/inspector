import {
  CLIENT_CAPABILITIES_META_KEY,
  CLIENT_INFO_META_KEY,
  PROTOCOL_VERSION_META_KEY,
} from "@modelcontextprotocol/client";

const HOST_OWNED_META = new Set([
  CLIENT_CAPABILITIES_META_KEY,
  CLIENT_INFO_META_KEY,
  PROTOCOL_VERSION_META_KEY,
]);

/** Preserve operation metadata; the upstream SDK owns its connection identity. */
export function bridgeRequestMetadata(value: unknown) {
  if (value === undefined) return undefined;
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new Error("Tool request metadata must be an object");
  return Object.fromEntries(
    Object.entries(value).filter(([key]) => !HOST_OWNED_META.has(key)),
  );
}

export function bridgeRequestParams(params: Record<string, unknown>) {
  const metadata = bridgeRequestMetadata(params._meta);
  return {
    ...params,
    ...(metadata === undefined ? {} : { _meta: metadata }),
  };
}
