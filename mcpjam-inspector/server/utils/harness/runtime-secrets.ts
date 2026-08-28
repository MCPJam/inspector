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
 * Deterministic fingerprint over the delivered set, order-independent.
 *
 * The value participates — it has to, because ROTATION is precisely "same name,
 * new value" and that is the event that must fork a session — but it
 * participates as a digest, never as itself. The runtime DTO carries no
 * `updatedAt` to use instead (the resolver returns the minimum a delivery
 * needs), so the digest is what stands in for one.
 *
 * Not a cryptographic claim, and not asked to be one: the only consumer is "is
 * this the same runtime as last turn". FNV-1a over `name value`, and the result
 * is folded into another hash by `harnessRuntimeFingerprint` before anything is
 * stored — so no digest of a credential is ever persisted on its own.
 *
 * Empty list ⇒ `""`, so a project with no secrets hashes identically to one
 * where this dimension does not exist and its sessions keep resuming.
 */
export function deliveredSecretsFingerprint(
  secrets: readonly RuntimeSecret[],
): string {
  if (secrets.length === 0) return "";
  const canon = secrets
    .map((secret) => {
      let v = 0x811c9dc5;
      const material = `${secret.name} ${secret.value}`;
      for (let i = 0; i < material.length; i++) {
        v ^= material.charCodeAt(i);
        v = Math.imul(v, 0x01000193);
      }
      return `${secret.name}:${(v >>> 0).toString(16)}`;
    })
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
