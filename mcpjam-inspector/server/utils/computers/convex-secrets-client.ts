/**
 * Thin client for the backend `projectSecretsNode` Convex functions.
 *
 * Mirrors `convex-skills-client.ts` — `ConvexHttpClient`, string function names,
 * local DTOs, no codegen dependency — with two deliberate differences.
 *
 * ## It calls an ACTION, not a query
 *
 * The skills family is query-only, so `.action(...)` is a first in it. That is
 * not a stylistic choice: the resolver has to DECRYPT, decryption is Node-only
 * in Convex, and a query cannot be a Node function. It is also the right shape
 * on its own terms — Convex queries are cached, replayable and subscribable, and
 * a credential should be none of those. `ConvexHttpClient` supports actions, so
 * the transport is unchanged.
 *
 * ## The bearer IS the authorization
 *
 * The backend action reads `ctx.actor.userId` from this bearer and checks the
 * personal-secret rule against it. There is no `userId` argument and there must
 * never be one: an argument would let this process name whose secrets it wants,
 * and the whole personal-secret guarantee rests on it being unable to.
 *
 * ## Write-only, here too
 *
 * There is no create/update/delete in this file. Those go over the v1 HTTP API
 * (`routes/v1/secrets.ts`), where they are audited and rate-limited like every
 * other write. This module exists solely to deliver values into a runtime.
 */
import { ConvexHttpClient } from "convex/browser";

/** One materialized secret, ready to be exported as an environment variable. */
export interface RuntimeSecret {
  /** The env-var name. Backend-validated `^[A-Z_][A-Z0-9_]*$`. */
  name: string;
  value: string;
  /**
   * The secret row's last write — the ROTATION MARKER, and metadata about the
   * row rather than about the credential.
   *
   * It exists so `deliveredSecretsFingerprint` can tell "same credential as
   * last turn" from "this was rotated" without hashing the value. A digest of a
   * credential, once folded into persisted session state, is an offline oracle
   * against any secret with guessable entropy; a timestamp is not.
   *
   * Optional only for the deploy window: a backend older than the change that
   * added it sends nothing, and the fingerprint falls back to a name-only
   * identity, which resumes sessions correctly but does not fork them on a
   * rotation until the backend catches up. Backend ships first, so the window
   * is the deploy itself.
   */
  updatedAt?: number;
}

/** Convex function names — one place, so a rename is one edit. */
const FN = {
  /**
   * MATERIALIZED secrets only. A brokered secret's value is never returned by
   * anything, to anyone — it reaches its box through E2B's egress proxy and
   * never enters this process. There is deliberately no sibling function that
   * would return one.
   */
  forRuntimeExecution: "projectSecretsNode:listSecretsForRuntimeExecution",
} as const;

function stripBearer(token: string): string {
  return token.replace(/^Bearer\s+/i, "").trim();
}

function makeClient(bearer: string): ConvexHttpClient {
  const url = process.env.CONVEX_URL;
  if (!url) {
    throw new Error("CONVEX_URL is not configured");
  }
  const client = new ConvexHttpClient(url);
  client.setAuth(stripBearer(bearer));
  return client;
}

/**
 * Fetch the materialized secrets this environment grants to THIS caller's
 * sessions.
 *
 * Throws on any failure. The tri-state wrapper (`runtime-secrets.ts`) is what
 * turns that into `{ ok: false }`, and the distinction matters enough that the
 * two live in different modules: an empty array here means "this environment
 * grants nothing", and a thrown error must never be flattened into it.
 */
export async function convexListSecretsForRuntimeExecution(
  bearer: string,
  args: {
    projectId: string;
    environmentId: string;
    /** Scopes the delivery throttle and the decrypt audit trail. Not authz. */
    chatSessionId?: string;
  },
): Promise<RuntimeSecret[]> {
  return await makeClient(bearer).action(FN.forRuntimeExecution as any, args);
}
