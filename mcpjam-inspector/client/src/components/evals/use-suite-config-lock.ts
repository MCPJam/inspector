import {
  useSuiteCapabilities,
  type SuiteCapabilities,
  type SuiteCapabilitiesState,
} from "@/hooks/use-suite-capabilities";
import { isCiOwnedSuite } from "@/lib/evals/is-ci-owned-suite";
import type { EvalSuite } from "./types";

export interface SuiteConfigLock {
  /** `null` until the capabilities read answers. */
  capabilities: SuiteCapabilities | null;
  capabilitiesState: SuiteCapabilitiesState["state"];
  configLocked: boolean;
  /** `readOnlyConfig || configLocked`: every EDITING gate reads this. */
  editingDisabled: boolean;
}

/**
 * Whether this suite's configuration may be edited here, and the capabilities
 * read that answer leans on.
 */
export function useSuiteConfigLock(
  suite: EvalSuite,
  opts: { configLocked?: boolean; readOnlyConfig?: boolean },
): SuiteConfigLock {
  // WHAT THE SUITE IS, asked twice, and both answers count.
  //
  // Re-asked on the suite's revision number: a save that changes what someone
  // may do next (upgrading the verdict policy) should change the rows, not
  // leave them describing the suite as it was when the page loaded.
  // ALWAYS the suite, never `isEditMode ? … : null`.
  //
  // Scoping this to edit mode is what the settings sheet needed when it was the
  // only reader. It is not what the LOCK needs. `configLocked` below is meant to
  // be two sources OR-ed, and on every surface but the settings sheet the second
  // one answered `unavailable` — so the case-authoring callbacks fell back to
  // the suite row alone, on exactly the surface where Add case and Generate
  // render. A capability that cannot be read where it is needed is not a second
  // source; it is a comment claiming there is one.
  //
  // The cost is one `getSuiteCapabilities` read per suite view. It is a
  // one-shot query keyed on the suite and its revision, not a subscription.
  const { state: capabilitiesState, capabilities } = useSuiteCapabilities(
    suite._id,
    suite.revisionNumber ?? "none",
  );
  // The ONE rule every row shares: when capabilities could not be read,
  // behave exactly as the page did before they existed. Capabilities make a
  // page more honest; they must never make it less usable than the page that
  // had none.
  const capabilitiesReady = capabilitiesState === "ready" && capabilities;

  // IS THIS SUITE CI'S? — asked of two sources, and answered once.
  //
  // OR-ed, because they fail in opposite directions. The SUITE ROW is complete
  // — `declaredSuiteId` and `source` both live on it — and answers before any
  // query resolves, which is why it cannot simply be replaced.
  // `getSuiteCapabilities.ownership` is the backend's own answer, from the same
  // predicate that will refuse the write, and it is the one that stays right if
  // the cached row is stale. Neither alone; a lock that disagrees with the
  // server is the bug this whole change exists to remove.
  //
  // THE ROW IS READ HERE, not taken from the caller. It used to arrive only as
  // `configLocked`, and `CiEvalsTab` never passed it — so on the CI Runs tab,
  // the surface most likely to be SHOWING a CI-owned suite, the row half was
  // simply absent and the lock was whatever the capability query had gotten
  // around to answering. Until it resolved, the suite was fully editable.
  //
  // `opts.configLocked` stays as a way to lock a suite for reasons of the
  // CALLER's own, which is a different question from whether CI owns it.
  const configLocked =
    opts.configLocked === true ||
    isCiOwnedSuite(suite) ||
    Boolean(capabilitiesReady && capabilities.ownership?.ciOwned === true);

  return {
    capabilities: capabilitiesReady ? capabilities : null,
    capabilitiesState,
    configLocked,
    // A CI-owned suite is read-only in exactly the same way as
    // `readOnlyConfig`, but keeps its Run controls.
    editingDisabled: opts.readOnlyConfig === true || configLocked,
  };
}
