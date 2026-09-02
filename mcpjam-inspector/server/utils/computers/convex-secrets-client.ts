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
  /**
   * Records that the values were actually PUT somewhere. Separate from the
   * fetch because resolving a secret is not delivering it — see the backend
   * comment on `markSecretsDelivered`.
   */
  markDelivered: "projectSecretsNode:markSecretsDelivered",
  /**
   * DELIVERY METADATA for every secret in a project the caller can see — names
   * and binding shape, never a value (the backend view type has no `value`
   * field at all).
   *
   * Read by the harness turn to answer ONE question a value-returning call
   * cannot: does a BROKERED secret exist for the credential an
   * external-account harness needs? Brokered values never enter this process,
   * so the only way to distinguish "the project brokers this credential" from
   * "the project has not configured it at all" is to ask about the row.
   */
  listMetadata: "projectSecrets:listSecrets",
  /**
   * The ENVIRONMENT's own secret SELECTION — which of the project's secret rows
   * a run launched from this environment is actually granted.
   *
   * Read alongside `listMetadata` because project scope is not grant scope. The
   * environment is the grant boundary (`projectEnvironments` →
   * `secretSelection.secretIds`), and `projectSecretsEgress` composes a box's
   * egress transform from exactly that selection — so a brokered row that
   * exists in the project but is NOT selected here is never delivered to the
   * box, and must never be reported as available.
   *
   * Returns ids the CALLER may see: the backend filters the selection through
   * `visibleSecretIdsFor`, so another member's personal secret is absent here
   * exactly as it is absent from `listSecrets`. That is the same rule
   * `listBrokeredSecretsForBox` re-checks live against the session owner.
   */
  environment: "projectEnvironments:getEnvironment",
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

/**
 * Record that this turn actually delivered the environment's materialized
 * secrets. Call ONLY when they reached a destination.
 *
 * `lastDeliveredAt` is what someone consults before deleting a credential they
 * believe is dormant, so it has to mean "in use", not "was resolved once". A
 * turn that fetches and then discards — no project-provisioned box, no
 * harness — must not move it.
 *
 * Best-effort by contract: the caller ignores failures, because failing to
 * RECORD a delivery must never fail the delivery itself.
 */
export async function convexMarkSecretsDelivered(
  bearer: string,
  args: { projectId: string; environmentId: string },
): Promise<{ marked: number }> {
  return await makeClient(bearer).action(FN.markDelivered as any, args);
}

/**
 * One project secret's DELIVERY METADATA. A hand-mirrored subset of the
 * backend's `projectSecrets:toSecretView`, carrying only what a delivery
 * decision needs.
 *
 * There is deliberately no `value` here, and there is nothing to add one from:
 * `listSecrets` is a metadata query whose return type has never had one.
 */
export interface ProjectSecretBinding {
  /**
   * The row id. Not the secret's identity — the NAME is — but it is what an
   * environment's `secretSelection` names, so it is the only way to ask whether
   * THIS run's environment actually grants THIS row. Always present:
   * `toSecretView` has returned it since the view existed.
   */
  secretId: string;
  /** The env-var name. This IS the secret's identity. */
  name: string;
  delivery: "brokered" | "materialized";
  /** Brokered rows only — the hosts the egress proxy injects the header on. */
  brokerHosts?: string[];
  /** Brokered rows only — lowercased at write time by the backend. */
  brokerHeader?: string;
  /** Brokered rows only — `{}` is where the plaintext is substituted. */
  brokerTemplate?: string;
}

/**
 * List the project's secret bindings (metadata only).
 *
 * Throws on any failure, like its sibling above; the caller decides what a
 * failure means. For the harness credential path it means "we could not
 * establish that this credential is brokered", which is refused rather than
 * assumed either way.
 *
 * PROJECT-SCOPED. That is the only shape the backend exposes, and it is NOT the
 * grant boundary — pair it with {@link convexGetEnvironmentSecretSelection} to
 * narrow it to the rows a run launched from a given environment receives.
 */
export async function convexListProjectSecretBindings(
  bearer: string,
  args: { projectId: string },
): Promise<ProjectSecretBinding[]> {
  const rows = (await makeClient(bearer).query(FN.listMetadata as any, {
    projectId: args.projectId,
  })) as ProjectSecretBinding[] | null;
  return rows ?? [];
}

/**
 * The secret row ids ONE environment grants — the caller-visible subset of its
 * `secretSelection`.
 *
 * An empty array is a real answer and the fail-closed default: an environment
 * with no selection grants NO secrets, which is exactly what the schema says
 * ("absent ⇒ NO secrets … the reason there is no 'all project secrets' mode").
 *
 * Throws on any failure, like its siblings; the caller decides what a failure
 * means. For the harness credential path it means "we could not establish that
 * this credential is granted", which is refused rather than assumed either way.
 */
export async function convexGetEnvironmentSecretSelection(
  bearer: string,
  args: { projectId: string; environmentId: string },
): Promise<string[]> {
  const environment = (await makeClient(bearer).query(FN.environment as any, {
    projectId: args.projectId,
    environmentId: args.environmentId,
  })) as { secretSelection?: { secretIds?: string[] } } | null;
  return environment?.secretSelection?.secretIds ?? [];
}
