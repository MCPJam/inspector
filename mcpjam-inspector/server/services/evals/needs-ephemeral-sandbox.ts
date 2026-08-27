/**
 * Does this eval iteration need a disposable box booted for it?
 *
 * Its own module, not an inline condition in the runner, because the rule is
 * load-bearing and was previously untestable without driving a whole iteration
 * — which is how the harness half of it went missing.
 */

/**
 * TWO reasons an iteration needs a box, not one:
 *
 *   - the run PINS a computer image — the box IS the reproducible environment
 *     the author asked for, and `bash` is exposed from it;
 *   - the run executes on a HARNESS — the harness needs a machine to be, and
 *     the only alternative `runHarnessTurn` has is `resolveHarnessSandbox`,
 *     i.e. the acting member's PERSONAL computer. Booting our own is what keeps
 *     eval execution off a shared, stateful box, so this must not be
 *     conditional on an image: an unpinned harness run simply gets the
 *     deployment-default template. The control plane resolves which image that
 *     is, so the provision call still names no template.
 *
 * A harness run that boots no box does not fail loudly — it silently runs on
 * someone's personal computer. That is why the harness arm is here rather than
 * left to a later "did we get a binding?" check.
 *
 * `runId` absent is the SINGLE-CASE surface, which never provisions (both
 * provisioning sites require a run). Admission refuses a harness there rather
 * than letting it reach the personal-computer fallback with no box.
 */
export function needsEphemeralEvalSandbox(args: {
  pinnedEnvironmentId?: string | undefined;
  harness?: string | undefined;
  runId: unknown;
}): boolean {
  if (args.runId === null || args.runId === undefined) return false;
  return Boolean(args.pinnedEnvironmentId) || Boolean(args.harness);
}
