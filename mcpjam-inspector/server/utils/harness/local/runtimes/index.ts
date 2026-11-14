/**
 * The runtimes that run on the member's own computer, one definition each.
 *
 * Every runtime is meant to run everywhere, the member's computer included:
 * `unavailableOn` in `shared/harness-descriptors.ts` lists the exceptions,
 * each with the reason a member reads. This registry is typed against that
 * list. A runtime without a `local` exception must have a definition here, and
 * one that still declares the exception cannot. Making a runtime local is:
 *
 *  1. Remove its `local` exception in `shared/harness-descriptors.ts` and in
 *     the backend's copy (`convex/lib/harnessDescriptors.ts`). The compiler
 *     then names what is missing: a definition here, and the client's copy
 *     (`local-runtime-copy.ts`) and rollout flag (`useLocalHarnessRollouts`).
 *  2. Add `runtimes/<harnessId>.ts`, a `LocalRuntime` (`types.ts`), and list
 *     it below. The compiler names every fact it has to declare.
 *  3. Add its pack recipe, `scripts/local-harness-pack-recipes/<harnessId>.mjs`,
 *     its Inspector layer bridge in `scripts/bundle-local-harness-layer.mjs`,
 *     and an empty entry in `runtime-compat.generated.json`.
 *  4. Run `conformance/run-runtime-conformance.ts <harnessId>` against a pack
 *     built from that recipe: a gateway turn, or the lifecycle of a runtime on
 *     its vendor's login. CI runs it on every target the definition
 *     advertises (`scripts/plan-local-harness-conformance.mjs`).
 *  5. Release it: the pack pipeline publishes its pack and records its
 *     conformance. Until then the release gate keeps it dark, so setup is not
 *     offered and evals never choose the local venue for it.
 *
 * `local-runtimes.test.ts` checks that these agree, and fails on a harness id
 * written into the generic runner instead of its definition.
 */
import type { SupportedLocalHarnessId } from "../targets.js";
import { claudeCodeLocalRuntime } from "./claude-code.js";
import { codexLocalRuntime } from "./codex.js";
import { copilotCliLocalRuntime } from "./copilot-cli.js";
import type { LocalRuntime } from "./types.js";

export type { LocalRuntime } from "./types.js";
export { DEFAULT_LOCAL_HARNESS_ID } from "../../../../../shared/harness-descriptors.js";

export const LOCAL_RUNTIMES: {
  readonly [Id in SupportedLocalHarnessId]: LocalRuntime<Id>;
} = {
  "claude-code": claudeCodeLocalRuntime,
  codex: codexLocalRuntime,
  "copilot-cli": copilotCliLocalRuntime,
};

/** The definition of a runtime the caller already knows is local. */
export function localRuntime<Id extends SupportedLocalHarnessId>(
  harnessId: Id,
): LocalRuntime<Id> {
  return LOCAL_RUNTIMES[harnessId];
}

/**
 * The definition for an id off the wire, or `undefined` when it names no
 * local runtime. OWN properties only: an id spelled `toString` or `__proto__`
 * would otherwise resolve to an inherited Object property.
 */
export function localRuntimeOf(
  harnessId: string | null | undefined,
): LocalRuntime | undefined {
  return typeof harnessId === "string" &&
    Object.prototype.hasOwnProperty.call(LOCAL_RUNTIMES, harnessId)
    ? LOCAL_RUNTIMES[harnessId as SupportedLocalHarnessId]
    : undefined;
}
