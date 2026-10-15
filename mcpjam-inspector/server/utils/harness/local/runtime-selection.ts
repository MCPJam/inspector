/**
 * Which installed runtime pack THIS Inspector build runs — decided per build,
 * from what is on disk, with no shared "current" pointer (invariant 4).
 *
 * Two Inspector versions sharing one runtime root each pick from their OWN
 * compatibility record (`runtime-compat.generated.json`): the pack this build
 * desires, or the one previous pack it was tested against and permits. A
 * pointer one of them wrote would be a choice made for the other.
 *
 * The rule, in order:
 *
 *   1. a revoked digest is never selected — not as desired, not as fallback;
 *   2. the pack a live grant already names, if it is still selectable and
 *      healthy (so an update activating in the background does not refuse the
 *      next turn of a session whose grant names the pack it replaced — the
 *      client renews the grant onto the new one);
 *   3. the desired pack, installed and healthy;
 *   4. the permitted previous pack, installed and healthy — which is what new
 *      sessions run while a candidate desired pack is downloading or probing,
 *      and after a desired pack was marked unhealthy (rollback);
 *   5. an unhealthy pack when it is the only one installed (degraded: the
 *      user can still work, and repair is offered);
 *   6. nothing: `revoked` when the desired pack was revoked and no fallback is
 *      usable (launch fails closed with that message), otherwise `absent`
 *      (a first-time install, which is the one case that waits).
 *
 * Pure, so the rule is tested as a function; `runtime-install.ts` gathers the
 * facts (install markers, the cached revocation list, health records).
 */

export type RuntimeRole = "desired" | "permitted";

export interface CandidateFacts {
  packVersion: string;
  treeDigest: string;
  /** A completed install of exactly this digest is on disk. */
  installed: boolean;
  revoked: boolean;
  unhealthy: boolean;
}

export type RuntimeChoice =
  | {
      kind: "selected";
      role: RuntimeRole;
      packVersion: string;
      treeDigest: string;
      /** Selected although marked unhealthy, because nothing healthier is installed. */
      degraded: boolean;
    }
  | { kind: "none"; why: "revoked" | "absent" };

export function chooseRuntime(input: {
  desired: CandidateFacts | null;
  permitted: CandidateFacts | null;
  /** The tree digest a live grant names, if any. */
  preferTreeDigest?: string | null;
}): RuntimeChoice {
  const candidates: Array<{ role: RuntimeRole; facts: CandidateFacts }> = [];
  if (input.desired) candidates.push({ role: "desired", facts: input.desired });
  // A permitted pack identical to the desired one is the same pack.
  if (input.permitted && input.permitted.treeDigest !== input.desired?.treeDigest) {
    candidates.push({ role: "permitted", facts: input.permitted });
  }
  const usable = candidates.filter(({ facts }) => facts.installed && !facts.revoked);
  const pick = (entry: { role: RuntimeRole; facts: CandidateFacts }): RuntimeChoice => ({
    kind: "selected",
    role: entry.role,
    packVersion: entry.facts.packVersion,
    treeDigest: entry.facts.treeDigest,
    degraded: entry.facts.unhealthy,
  });

  const preferred = usable.find(
    ({ facts }) => input.preferTreeDigest != null && facts.treeDigest === input.preferTreeDigest && !facts.unhealthy,
  );
  if (preferred) return pick(preferred);
  const healthy = usable.find(({ facts }) => !facts.unhealthy);
  if (healthy) return pick(healthy);
  if (usable[0]) return pick(usable[0]);
  return { kind: "none", why: input.desired?.revoked ? "revoked" : "absent" };
}
