/**
 * Materialized project secrets as a runtime concern.
 *
 * The sibling of `runtime-skills.ts`, and shaped like it on purpose: one
 * tri-state fetch, one deterministic fingerprint folded into the harness runtime
 * fingerprint, and nothing else. What differs is what a mistake costs.
 *
 *   - `fetchRuntimeSecrets` — TRI-STATE. `{ ok: false }` is NOT `[]`. A
 *     transient Convex failure that read as "no secrets" would silently strip a
 *     working session's credentials and leave the user watching a `stripe`
 *     command fail with no explanation.
 *   - `deliveredSecretsFingerprint` — folded into `harnessRuntimeFingerprint`,
 *     so a ROTATION forks a resumable session. This is not hygiene: the
 *     `ANTHROPIC_BASE_URL` compat bump in `run-harness-turn.ts` records the
 *     exact prior bug — "resumed sessions reconnect to a bridge process holding
 *     the OLD env". A rotated value that did not fork the session would be
 *     delivered to a bridge that already holds the old one, and the user would
 *     see the rotation land everywhere except the conversation they were in.
 *
 * Brokered secrets never appear here. Their values do not enter this process at
 * all — the backend composes them into the box's egress policy — so there is
 * nothing to fetch, fingerprint, or scrub. Rotating a brokered secret reaches
 * new boxes only, the same "sessions created after" rule.
 */
import {
  convexListSecretsForRuntimeExecution,
  convexMarkSecretsDelivered,
  type RuntimeSecret,
} from "../computers/convex-secrets-client.js";
import { logger } from "../logger.js";

export type { RuntimeSecret };

export type FetchRuntimeSecretsResult =
  | { ok: true; secrets: RuntimeSecret[] }
  | { ok: false };

/**
 * Fetch the materialized secrets for this turn. Never throws, never returns `[]`
 * to mean "failed".
 *
 * Requires an ENVIRONMENT. A turn with no environment has no grant — the
 * environment IS the grant boundary — so that reports an empty success rather
 * than a failure: nothing is wrong, there is simply nothing granted. Same for a
 * turn with no bearer (a guest), which the backend would reject anyway.
 */
export async function fetchRuntimeSecrets(
  bearer: string | undefined,
  args: { projectId?: string; environmentId?: string; chatSessionId?: string },
): Promise<FetchRuntimeSecretsResult> {
  if (!bearer || !args.projectId || !args.environmentId) {
    return { ok: true, secrets: [] };
  }
  try {
    const secrets = await convexListSecretsForRuntimeExecution(bearer, {
      projectId: args.projectId,
      environmentId: args.environmentId,
      ...(args.chatSessionId ? { chatSessionId: args.chatSessionId } : {}),
    });
    return { ok: true, secrets };
  } catch (error) {
    logger.warn(
      "[runtime-secrets] fetch failed; preserving prior secret state",
      { error: error instanceof Error ? error.message : String(error) },
    );
    return { ok: false };
  }
}

/**
 * Resolve this turn's materialized secrets EXACTLY ONCE, honouring a caller
 * that already resolved them — including a caller that already FAILED.
 *
 * The tri-state has three answers and all three have to survive being handed
 * down a call chain: secrets, none, or "could not find out". Keying only on
 * "did the caller pass a list?" collapses the third into "the caller did not
 * resolve", which licenses a second attempt.
 *
 * That retry is not merely wasteful, it is unsafe. If the retry SUCCEEDS the
 * turn delivers real values into the box while the caller's established failure
 * still forces the `unavailable` fingerprint — so the session persists a
 * fingerprint that says "nothing was delivered" against a bridge that now holds
 * credentials. A later turn that genuinely fails computes the same fingerprint,
 * resumes that bridge, and has no list to build a scrubber from. The fork exists
 * to prevent exactly that resume; a retry is how you walk back into it.
 *
 * So: an established failure short-circuits. `unavailable` is then only ever
 * persisted by a turn that really did deliver nothing.
 */
export async function resolveTurnRuntimeSecrets(args: {
  /** What the caller resolved, if it resolved anything. */
  callerSecrets?: RuntimeSecret[];
  /** Whether the caller's own resolution FAILED. Outranks `callerSecrets`. */
  callerUnavailable?: boolean;
  /** Used only when the caller resolved nothing at all. */
  fetch: () => Promise<FetchRuntimeSecretsResult>;
}): Promise<FetchRuntimeSecretsResult> {
  if (args.callerUnavailable === true) return { ok: false };
  if (args.callerSecrets !== undefined) {
    return { ok: true, secrets: args.callerSecrets };
  }
  return await args.fetch();
}

/**
 * Deterministic fingerprint over the delivered set, order-independent.
 *
 * ## No credential material participates, at any strength
 *
 * The obvious spelling is to hash the values: rotation is precisely "same name,
 * new value", so the value looks like the only thing that distinguishes the two
 * runtimes. It is also the wrong spelling, and unsalted-hashing it is not a
 * repair. This fingerprint is folded into `harnessRuntimeFingerprint` and
 * PERSISTED in session state, so anyone who reads that metadata and knows the
 * secret name plus the rest of the runtime config can score guesses offline
 * against it. For a credential with real entropy that is nothing; for the PIN,
 * the short password, the four-digit account code someone stored here anyway,
 * it is a working oracle — and the point of the encrypted store is that such a
 * secret is not brute-forceable from anything we keep.
 *
 * So the ROTATION MARKER travels instead: `updatedAt`, which the backend
 * resolver already has on the row and which moves on exactly the event that
 * must fork a session. A timestamp reveals when the row was written and nothing
 * about what it holds.
 *
 * A backend that predates the marker sends none, and such a secret contributes
 * its name alone: the session keeps resuming, and stops forking on rotation
 * until that backend ships. Backend deploys first, so the window is the deploy.
 * Degrading to a stale-value risk is the right trade against re-introducing a
 * guessing oracle, and it is the same "rotation reaches new runs only" rule
 * brokered secrets live under permanently.
 *
 * Not a cryptographic claim and not asked to be one — the only consumer is "is
 * this the same runtime as last turn", and FNV-1a over non-secret material is
 * exactly the right size for that.
 *
 * Empty list ⇒ `""`, so a project with no secrets hashes identically to one
 * where this dimension does not exist and its sessions keep resuming.
 */
export function deliveredSecretsFingerprint(
  secrets: readonly RuntimeSecret[],
): string {
  if (secrets.length === 0) return "";
  const canon = secrets
    .map((secret) =>
      secret.updatedAt === undefined
        ? secret.name
        : `${secret.name}:${secret.updatedAt}`,
    )
    .sort()
    .join("\n");
  let h = 0x811c9dc5;
  for (let i = 0; i < canon.length; i++) {
    h ^= canon.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16);
}

/**
 * The env bag a sandbox command should carry.
 *
 * Separate from the fetch so the caller holds ONE fetched list and derives both
 * the bag and the scrubber registry from it. Two reads would be two chances for
 * the registry to be missing a value the box actually received — which is the
 * one way this feature leaks by accident.
 */
export function toSecretEnv(
  secrets: readonly RuntimeSecret[],
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const secret of secrets) env[secret.name] = secret.value;
  return env;
}

/**
 * Record that this turn actually delivered its materialized secrets.
 *
 * Fire-and-forget, and never throws: `lastDeliveredAt` is an operational signal,
 * and a turn that ran correctly must not fail because a bookkeeping write did
 * not. The backend throttles the stamp, so calling this on every delivering turn
 * costs a round trip and at most one row revision a minute.
 *
 * Call it only when the values REACHED something. The fetch deliberately does
 * not stamp: it happens before the turn's destination is known, and a turn that
 * ends up discarding them (no project-provisioned box, no harness) would
 * otherwise report a delivery that never happened — turning "is this credential
 * still in use?" into "was it resolved once?", which is the question someone
 * asks precisely when deciding whether it is safe to delete.
 */
export async function markRuntimeSecretsDelivered(
  bearer: string | undefined,
  args: { projectId?: string; environmentId?: string; secretCount: number },
): Promise<void> {
  if (!bearer || !args.projectId || !args.environmentId) return;
  if (args.secretCount <= 0) return;
  try {
    await convexMarkSecretsDelivered(bearer, {
      projectId: args.projectId,
      environmentId: args.environmentId,
    });
  } catch (error) {
    logger.warn("[runtime-secrets] delivery stamp failed", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
