/**
 * What a hosted MCP client manager knew about each server BEFORE it connected,
 * and what the wire told it when the connect was refused.
 *
 * Two facts decide whether a 401 can be explained, and neither is on the
 * error object the transport throws:
 *
 *   - the AUTH CONTEXT: which method the server was configured with and
 *     whether a credential was actually sent. A 401 against a server we never
 *     sent a credential to is "requires authorization and none is stored"; the
 *     same 401 after a stored token went out is "rejected the stored token".
 *   - the CHALLENGE: the parsed `WWW-Authenticate` of the 401/403 response.
 *     The transport error keeps the status and the body text, never the
 *     header — and the header is the one thing that says whether the server
 *     told the client how to authorize at all.
 *
 * Both are attached to the manager instance in a WeakMap rather than threaded
 * through every route → runner call chain, because the manager is the one
 * object every consumer already holds. Nothing here is persisted; the evals
 * runner copies what it needs into its own bounded, redaction-safe record.
 */

import type { BearerChallengeSummary } from "@mcpjam/sdk";
import type { EffectiveAuthMethod } from "../utils/effective-auth.js";

export type ConnectionAuthContext = {
  method: EffectiveAuthMethod;
  /** A bearer credential (stored token, minted XAA token or header) went out. */
  credentialSent: boolean;
  /** An `onUnauthorized` refresh path was installed for this server. */
  refreshable: boolean;
  serverUrl?: string;
};

export type ConnectionContext = {
  auth?: ConnectionAuthContext;
  challenge?: BearerChallengeSummary;
};

type ManagerContext = {
  auth: Map<string, ConnectionAuthContext>;
  challenges: Map<string, BearerChallengeSummary>;
};

const CONTEXTS = new WeakMap<object, ManagerContext>();

function contextFor(manager: object): ManagerContext {
  let ctx = CONTEXTS.get(manager);
  if (!ctx) {
    ctx = { auth: new Map(), challenges: new Map() };
    CONTEXTS.set(manager, ctx);
  }
  return ctx;
}

/**
 * Origin + path of a URL, the key challenges are recorded under. Query and
 * userinfo are dropped: a server's challenge is a property of the endpoint,
 * and the query string is where a stored URL carries things this must not.
 */
export function connectionUrlKey(url: string): string | undefined {
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname.replace(/\/+$/, "")}`;
  } catch {
    return undefined;
  }
}

export function attachConnectionAuthContext(
  manager: object,
  serverId: string,
  auth: ConnectionAuthContext,
): void {
  contextFor(manager).auth.set(serverId, auth);
}

/**
 * Hand the manager the challenge map its base fetch writes into. The fetch is
 * built before the manager exists, so the map is created first and attached
 * once the constructor has returned.
 */
export function attachConnectionChallenges(
  manager: object,
  challenges: Map<string, BearerChallengeSummary>,
): void {
  const ctx = contextFor(manager);
  for (const [key, value] of challenges) ctx.challenges.set(key, value);
  // Keep writing into the SAME map the fetch holds, so later challenges land.
  ctx.challenges = challenges;
}

/** The map a base fetch writes 401/403 challenges into; attach it to the manager. */
export function createChallengeStore(): Map<string, BearerChallengeSummary> {
  return new Map();
}

export function recordConnectionChallenge(
  challenges: Map<string, BearerChallengeSummary>,
  url: string,
  challenge: BearerChallengeSummary,
): void {
  const key = connectionUrlKey(url);
  if (key) challenges.set(key, challenge);
}

/**
 * Everything recorded for one server, or `undefined` when this manager was
 * never enrolled (tests, and managers built outside `createAuthorizedManager`).
 * The challenge is looked up by the server's configured URL; a manager that
 * exposes `getServerConfig` supplies it when the auth context did not.
 */
export function connectionContextFor(
  manager: object,
  serverId: string,
): ConnectionContext | undefined {
  const ctx = CONTEXTS.get(manager);
  if (!ctx) return undefined;
  const auth = ctx.auth.get(serverId);
  const configUrl = (() => {
    const getter = (
      manager as {
        getServerConfig?: (id: string) => { url?: unknown } | undefined;
      }
    ).getServerConfig;
    if (typeof getter !== "function") return undefined;
    try {
      const url = getter.call(manager, serverId)?.url;
      return typeof url === "string" ? url : undefined;
    } catch {
      return undefined;
    }
  })();
  const url = auth?.serverUrl ?? configUrl;
  const key = url ? connectionUrlKey(url) : undefined;
  const challenge = key ? ctx.challenges.get(key) : undefined;
  if (!auth && !challenge) return undefined;
  return {
    ...(auth ? { auth } : {}),
    ...(challenge ? { challenge } : {}),
  };
}
