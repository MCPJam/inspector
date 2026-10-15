/**
 * The CANONICAL import eligibility for the run the user has open.
 *
 * Fetched, not derived. Two things could have produced this object locally and
 * both are wrong:
 *
 *   - The run LIST projection (`listTestSuiteRuns`, which feeds
 *     `use-eval-queries`) does not carry eligibility, so a row from it has
 *     `importEligibility: undefined`. Rendering that as "no imported cases"
 *     would tell a reader a converted run was native.
 *   - The suite's CURRENT cases could be walked to guess what the run decided.
 *     That is the failure this whole hook exists to prevent: cases are edited
 *     after runs finish, so recomputing would let an edit retroactively rewrite
 *     what a finished run is shown to have decided — and the frozen approval
 *     receipts (who approved, when, why) exist nowhere else at all.
 *
 * So the run detail asks `getTestSuiteRun` for the run it is displaying, which
 * derives eligibility from that run's OWN frozen snapshot. The lighter of the
 * two canonical queries is enough: it already carries the approval receipts,
 * and `getTestSuiteRunDetails` would additionally pull every iteration this
 * screen has already loaded by another route.
 */

import { useMemo } from "react";
import { useQueries } from "convex/react";
import { makeFunctionReference } from "convex/server";
import type { ImportEligibility } from "./types";

const runQuery = makeFunctionReference<
  "query",
  { runId: string },
  { importEligibility?: ImportEligibility } | null
>("testSuites:getTestSuiteRun");

export type RunImportEligibilityState = {
  /**
   * `undefined` while loading AND when the deployment reports none.
   *
   * Deliberately not disambiguated into a third state here: every caller's
   * correct behaviour for both is to render nothing, and a `loading` flag
   * would invite a "no imported cases" placeholder to appear during the
   * fetch and then be replaced by real evidence a moment later.
   */
  eligibility: ImportEligibility | undefined;
  isLoading: boolean;
};

export function useRunImportEligibility(
  runId: string | null | undefined,
  options: { enabled?: boolean } = {},
): RunImportEligibilityState {
  const enabled = options.enabled !== false && Boolean(runId);
  // `useQueries`, not `useQuery`: deleting the open run re-runs this read
  // against a missing row, and `useQuery` would re-throw "Suite run not found"
  // into the render (Sentry CONVEX-19P). A failed read settles as absent.
  // Convex keys its subscriptions by this object's identity.
  const queries = useMemo<Parameters<typeof useQueries>[0]>(
    (): Parameters<typeof useQueries>[0] =>
      enabled && runId ? { run: { query: runQuery, args: { runId } } } : {},
    [enabled, runId],
  );
  const run = useQueries(queries).run as
    { importEligibility?: ImportEligibility } | null | Error | undefined;

  return {
    eligibility: run instanceof Error ? undefined : run?.importEligibility,
    isLoading: enabled && run === undefined,
  };
}
