import { randomUUID } from "node:crypto";

const FLOW_TTL_MS = 15 * 60_000;
const MAX_ACTIVE_FLOWS = 100;

interface OAuthDebugFlow {
  allowedPrivateNetworkOrigins: string[];
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
    expiresAt: Date.now() + FLOW_TTL_MS,
  });
  return id;
}

export function getOAuthDebugFlowAllowedOrigins(id: unknown): string[] {
  if (typeof id !== "string") return [];

  const flow = flows.get(id);
  if (!flow) return [];
  if (flow.expiresAt <= Date.now()) {
    flows.delete(id);
    return [];
  }
  return flow.allowedPrivateNetworkOrigins;
}
