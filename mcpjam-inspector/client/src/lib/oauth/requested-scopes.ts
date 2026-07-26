/**
 * 2R-stepup (SEP-2350, §10.2 item 4) — persisted requested scopes per issuer.
 *
 * A runtime scope step-up unions the scopes previously requested for a server's
 * authorization-server issuer with the scopes a later `403 insufficient_scope`
 * challenges. That union only exists if the previously-requested set survives
 * across requests, so we persist it, keyed by exact issuer (reusing the 2R-store
 * issuer-keyed store) — a scope set requested against AS A must never be unioned
 * into a re-authorization against AS B.
 */

import { computeScopeUnion } from "@mcpjam/sdk/browser";
import {
  readIssuerKeyed,
  writeIssuerKeyed,
} from "./issuer-keyed-storage";

const REQUESTED_SCOPES_PREFIX = "mcp-scopes-";

function storageKey(serverName: string): string {
  return `${REQUESTED_SCOPES_PREFIX}${serverName}`;
}

function getStore(): Storage | undefined {
  try {
    return typeof localStorage !== "undefined" ? localStorage : undefined;
  } catch {
    return undefined;
  }
}

/** Narrow a raw (pre-migration) parsed value to a scope array. */
function parseLegacyScopes(parsed: unknown): string[] | undefined {
  if (
    Array.isArray(parsed) &&
    parsed.every((scope) => typeof scope === "string")
  ) {
    return parsed as string[];
  }
  return undefined;
}

/**
 * Read the scopes last requested for `serverName` against `issuer`. Returns
 * `undefined` when nothing is stored for that exact issuer, so a step-up never
 * unions another AS's scopes.
 */
export function readRequestedScopes(
  serverName: string,
  issuer: string | undefined,
): string[] | undefined {
  // Never fall back to the envelope's `activeIssuer` (readIssuerKeyed's
  // no-issuer default) or to a legacy unkeyed record here: a step-up before
  // issuer discovery, or after an AS switch, must not union another AS's
  // scopes into the re-authorization (SEP-2352). Only an exact issuer-bound
  // record is reusable.
  if (!issuer) {
    return undefined;
  }
  const store = getStore();
  if (!store) {
    return undefined;
  }
  const read = readIssuerKeyed<string[]>(
    store.getItem(storageKey(serverName)),
    issuer,
    parseLegacyScopes,
  );
  return read.legacyUnbound ? undefined : read.value;
}

/**
 * Persist the scopes requested for `serverName` against `issuer`. A known issuer
 * promotes the record into the issuer-keyed store; an unknown issuer is a no-op
 * (there is no binding to record yet — the next issuer-stamped save carries it).
 */
export function persistRequestedScopes(
  serverName: string,
  issuer: string | undefined,
  scopes: string[] | undefined,
): void {
  const store = getStore();
  if (!store || !issuer) {
    return;
  }
  const normalized = computeScopeUnion(scopes);
  if (normalized.length === 0) {
    return;
  }
  try {
    const next = writeIssuerKeyed<string[]>(
      store.getItem(storageKey(serverName)),
      issuer,
      normalized,
    );
    store.setItem(storageKey(serverName), JSON.stringify(next));
  } catch {
    // Best-effort persistence: a full/unavailable store (quota, private mode)
    // must not abort the OAuth flow — the step-up simply unions less history.
  }
}

/**
 * The scope set a step-up re-authorization should request: the union of the
 * scopes ORIGINALLY requested by the server's OAuth flow, the scopes persisted
 * for this issuer from a prior step-up, and the scopes challenged by the `403
 * insufficient_scope` response.
 *
 * `originalScopes` matters on the FIRST runtime step-up: nothing has been
 * persisted yet (the persisted set only exists after a prior step-up
 * re-authorization), so without the originally-requested scopes the union would
 * collapse to just the challenged scopes and the re-authorization would DROP the
 * scopes the original grant already held — the server would come back
 * still-insufficient on the pre-existing scopes.
 */
export function stepUpScopeUnion(
  serverName: string,
  issuer: string | undefined,
  challengedScopes: string[] | undefined,
  originalScopes?: string[],
): string[] {
  // Order: original-requested first, then any issuer-persisted prior union,
  // then the newly-challenged scopes. computeScopeUnion de-dupes and preserves
  // first-seen order.
  const previouslyRequested = computeScopeUnion(
    originalScopes,
    readRequestedScopes(serverName, issuer),
  );
  return computeScopeUnion(previouslyRequested, challengedScopes);
}
