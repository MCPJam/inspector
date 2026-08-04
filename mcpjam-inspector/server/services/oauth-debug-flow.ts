import { randomUUID } from "node:crypto";
import { lookup } from "node:dns/promises";
import { isPrivateNetworkAddress } from "@mcpjam/sdk/browser";

const FLOW_TTL_MS = 15 * 60_000;
const MAX_ACTIVE_FLOWS = 100;

interface OAuthDebugFlow {
  allowedPrivateNetworkOrigins: string[];
  discoveredPrivateNetworkOrigins: Set<string>;
  resourceOrigin: string;
  expiresAt: number;
}

const flows = new Map<string, OAuthDebugFlow>();

function normalizeHttpOrigin(value: string): string | undefined {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:"
      ? url.origin
      : undefined;
  } catch {
    return undefined;
  }
}

function getActiveFlow(id: unknown): OAuthDebugFlow | undefined {
  if (typeof id !== "string") return undefined;

  const flow = flows.get(id);
  if (!flow) return undefined;
  if (flow.expiresAt <= Date.now()) {
    flows.delete(id);
    return undefined;
  }
  return flow;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function getHeader(
  headers: Record<string, string> | undefined,
  name: string
): string | undefined {
  return Object.entries(headers ?? {}).find(
    ([key]) => key.toLowerCase() === name
  )?.[1];
}

function addOrigin(origins: Set<string>, value: unknown): void {
  if (typeof value !== "string") return;
  const origin = normalizeHttpOrigin(value);
  if (origin) origins.add(origin);
}

function extractResourceMetadataOrigin(
  wwwAuthenticate: string | undefined
): string | undefined {
  const match = wwwAuthenticate?.match(
    /\bresource_metadata\s*=\s*"([^"\\]+)"/i
  );
  return match ? normalizeHttpOrigin(match[1]) : undefined;
}

function isProtectedResourceMetadata(
  metadata: Record<string, unknown>,
  resourceOrigin: string
): boolean {
  // RFC 9728 allows resource_metadata to name the metadata URL directly, so
  // validate the document's required resource binding rather than requiring a
  // particular well-known path. It must point back to the MCP server selected
  // at the beginning of this flow.
  return (
    typeof metadata.resource === "string" &&
    normalizeHttpOrigin(metadata.resource) === resourceOrigin &&
    Array.isArray(metadata.authorization_servers)
  );
}

function isAuthorizationServerMetadataUrl(finalUrl: string): boolean {
  try {
    const pathname = new URL(finalUrl).pathname;
    return (
      pathname.includes("/.well-known/oauth-authorization-server") ||
      pathname.endsWith("/.well-known/openid-configuration")
    );
  } catch {
    return false;
  }
}

function extractDiscoveredOrigins(
  input: {
    status: number;
    headers?: Record<string, string>;
    body: unknown;
    finalUrl: string;
  },
  resourceOrigin: string
): Set<string> {
  const origins = new Set<string>();
  if (input.status === 401) {
    const resourceMetadataOrigin = extractResourceMetadataOrigin(
      getHeader(input.headers, "www-authenticate")
    );
    if (resourceMetadataOrigin) origins.add(resourceMetadataOrigin);
  }

  if (input.status < 200 || input.status >= 300) return origins;
  const metadata = asRecord(input.body);
  if (!metadata) return origins;

  // RFC 9728 protected-resource metadata names the authorization server.
  if (isProtectedResourceMetadata(metadata, resourceOrigin)) {
    for (const value of metadata.authorization_servers)
      addOrigin(origins, value);
  }

  // Do not trust arbitrary JSON that merely resembles authorization-server
  // metadata. These fields are the same minimum validation the debugger uses
  // before it proceeds to registration or token exchange.
  const metadataOrigin = normalizeHttpOrigin(input.finalUrl);
  const issuer =
    typeof metadata.issuer === "string"
      ? normalizeHttpOrigin(metadata.issuer)
      : undefined;
  const supportsCode =
    Array.isArray(metadata.response_types_supported) &&
    metadata.response_types_supported.includes("code");
  if (
    !isAuthorizationServerMetadataUrl(input.finalUrl) ||
    !metadataOrigin ||
    issuer !== metadataOrigin ||
    !supportsCode
  ) {
    return origins;
  }
  if (
    typeof metadata.authorization_endpoint !== "string" ||
    typeof metadata.token_endpoint !== "string"
  ) {
    return origins;
  }

  addOrigin(origins, metadata.authorization_endpoint);
  addOrigin(origins, metadata.token_endpoint);
  addOrigin(origins, metadata.registration_endpoint);
  return origins;
}

async function isPrivateNetworkOrigin(origin: string): Promise<boolean> {
  const hostname = new URL(origin).hostname;
  if (isPrivateNetworkAddress(hostname)) return true;

  try {
    const addresses = await lookup(hostname, { all: true, verbatim: true });
    return addresses.some((address) =>
      isPrivateNetworkAddress(address.address)
    );
  } catch {
    // The proxy performs the authoritative DNS validation immediately before
    // connecting. A failed lookup must not create an approval candidate.
    return false;
  }
}

function removeExpiredFlows(now = Date.now()): void {
  for (const [id, flow] of flows) {
    if (flow.expiresAt <= now) flows.delete(id);
  }
}

/**
 * Start a debugger flow for the MCP server the user selected. The opaque flow
 * id keeps the private-origin policy on the server; callers cannot provide an
 * arbitrary allowlist on individual proxy requests.
 */
export function createOAuthDebugFlow(serverUrl: string): string | undefined {
  const origin = normalizeHttpOrigin(serverUrl);
  if (!origin) return undefined;

  removeExpiredFlows();
  while (flows.size >= MAX_ACTIVE_FLOWS) {
    const oldestId = flows.keys().next().value;
    if (!oldestId) break;
    flows.delete(oldestId);
  }

  const id = randomUUID();
  flows.set(id, {
    allowedPrivateNetworkOrigins: [origin],
    discoveredPrivateNetworkOrigins: new Set(),
    resourceOrigin: origin,
    expiresAt: Date.now() + FLOW_TTL_MS,
  });
  return id;
}

export function getOAuthDebugFlowAllowedOrigins(id: unknown): string[] {
  return getActiveFlow(id)?.allowedPrivateNetworkOrigins ?? [];
}

/**
 * Records private OAuth origins found in an actual debugger response. They
 * remain blocked until the user explicitly approves that exact origin.
 */
export async function recordOAuthDebugFlowDiscovery(
  id: unknown,
  response: {
    status: number;
    headers?: Record<string, string>;
    body: unknown;
    finalUrl: string;
  }
): Promise<string[]> {
  const flow = getActiveFlow(id);
  if (!flow) return [];

  const pendingOrigins: string[] = [];
  for (const origin of extractDiscoveredOrigins(
    response,
    flow.resourceOrigin
  )) {
    if (
      flow.allowedPrivateNetworkOrigins.includes(origin) ||
      flow.discoveredPrivateNetworkOrigins.has(origin) ||
      !(await isPrivateNetworkOrigin(origin))
    ) {
      continue;
    }
    flow.discoveredPrivateNetworkOrigins.add(origin);
    pendingOrigins.push(origin);
  }
  return pendingOrigins;
}

/**
 * Approve a private origin only when it was discovered from this flow's actual
 * OAuth response. This prevents callers from adding arbitrary intranet hosts.
 */
export function approveOAuthDebugFlowOrigin(
  id: unknown,
  originValue: unknown
): string | undefined {
  const flow = getActiveFlow(id);
  if (!flow || typeof originValue !== "string") return undefined;

  const origin = normalizeHttpOrigin(originValue);
  if (!origin || !flow.discoveredPrivateNetworkOrigins.has(origin)) {
    return undefined;
  }
  flow.discoveredPrivateNetworkOrigins.delete(origin);
  flow.allowedPrivateNetworkOrigins.push(origin);
  return origin;
}
