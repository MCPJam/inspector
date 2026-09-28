/**
 * The case ids a run's iteration could be filed under, mirrored client-side.
 *
 * SYNC: `mcpjam-backend/convex/lib/evalVerdictFinalization.ts` — `contractCaseId`,
 * `evalV2CaseIdentity`, `evalV2CaseIdentityCandidates`, `executionVariantOf`.
 * Change either side and this join silently stops matching.
 *
 * ── Why a mirror exists at all ───────────────────────────────────────────────
 *
 * `decision.cases[]` is keyed by an ENCODED identity the platform mints, and
 * the contract says so in as many words: neither a diagnostic's `caseId` nor
 * its `testCaseId` joins to it, and matching on either "would silently attach a
 * trial to the wrong aggregate". Nothing on the wire carries the minted id back
 * to the browser, so a page that wants to show a case's own verdict — the one
 * decided against that case's own threshold — has to re-derive the key.
 *
 * Doing that is a liability, and it is bounded on purpose:
 *
 *   - Only the READABLE families are minted. The backend hashes anything that
 *     does not fit its id pattern into `<space>h_<sha256>`, and sha256 is not
 *     available synchronously in a browser. An unencodable identity therefore
 *     produces NO candidate, the row reports `identityNotEncodable`, and the
 *     page falls back to the iteration fraction instead of guessing.
 *   - A miss is a stated state, never a default. `noMatch` renders as "no
 *     verdict row matched this case", which is a true and checkable claim; a
 *     silent fallback to "passed" would not be.
 *
 * The residual is filed: exposing the minted `caseId` on the iteration DTO
 * deletes this file.
 */
import {
  evalCaseAggregationKey,
  type EvalExecutionVariant,
} from "@mcpjam/sdk/contract";

import type { EvalIteration } from "../evals/types";

/**
 * The backend's `CONTRACT_CASE_ID_PATTERN`.
 *
 * An identity that fails it is hashed server-side rather than rejected, so
 * failing it here means "cannot mint", not "invalid".
 */
const CONTRACT_CASE_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

/** The readable encodings of a stored `caseKey`. Mirrors `readableStoredKey`. */
function readableStoredKey(caseKey: string): string | undefined {
  if (caseKey.startsWith("hash:")) {
    return `k_hash_${caseKey.slice("hash:".length)}`;
  }
  if (caseKey.startsWith("external:")) {
    return `k_ext_${caseKey.slice("external:".length)}`;
  }
  return undefined;
}

function contractCaseId(space: "k" | "c" | "d", raw: string): string | null {
  const readable = space === "k" ? readableStoredKey(raw) : `${space}_${raw}`;
  if (readable !== undefined && CONTRACT_CASE_ID_PATTERN.test(readable)) {
    return readable;
  }
  // The backend would hash here. The browser cannot, so it declines rather
  // than minting something that will never match.
  return null;
}

export type CaseIterationIdentity = Pick<
  EvalIteration,
  "testCaseId" | "testCaseSnapshot"
>;

/**
 * Every id this iteration could be filed under, MOST SPECIFIC FIRST.
 *
 * The order is the backend's and matters: an adopted case keeps snapshotting
 * the `caseKey` its earlier iterations carry, so preferring a declared id would
 * split one case's history in two.
 */
export function mintCaseIdCandidates(
  iteration: CaseIterationIdentity,
): string[] {
  const candidates: string[] = [];
  const caseKey = iteration.testCaseSnapshot?.caseKey;
  const testCaseId = iteration.testCaseId;

  const stored =
    caseKey !== undefined && caseKey.length > 0
      ? contractCaseId("k", caseKey)
      : testCaseId !== undefined && testCaseId.length > 0
        ? contractCaseId("c", testCaseId)
        : null;
  if (stored) candidates.push(stored);

  if (testCaseId !== undefined && testCaseId.length > 0) {
    const byRowId = contractCaseId("c", testCaseId);
    if (byRowId && !candidates.includes(byRowId)) candidates.push(byRowId);
  }

  const declared = (
    iteration.testCaseSnapshot as { caseId?: string } | undefined
  )?.caseId;
  if (declared !== undefined && declared.length > 0) {
    const byDeclared = contractCaseId("d", declared);
    if (byDeclared && !candidates.includes(byDeclared)) {
      candidates.push(byDeclared);
    }
  }

  return candidates;
}

/** The variant an iteration ran under, when its snapshot names a model. */
export function executionVariantOf(
  iteration: CaseIterationIdentity,
): EvalExecutionVariant | undefined {
  const snapshot = iteration.testCaseSnapshot as
    { model?: string; provider?: string } | undefined;
  const model = snapshot?.model;
  if (model === undefined || model.length === 0) return undefined;
  const provider = snapshot?.provider;
  return {
    model,
    ...(provider !== undefined && provider.length > 0 ? { provider } : {}),
  };
}

/**
 * Find the aggregation key this iteration's verdict lives under.
 *
 * `variantKeyedCaseIds` is the set of case ids the DECISION keyed by variant.
 * Reading the iteration's own model when the decision did not fan out that case
 * would build a key no row can equal — which is the backend's rule, not a
 * defensive flourish.
 */
export function aggregationKeyForIteration(
  iteration: CaseIterationIdentity,
  variantKeyedCaseIds: ReadonlySet<string>,
  hasKey: (key: string) => boolean,
): { caseId: string; aggregationKey: string } | null {
  for (const caseId of mintCaseIdCandidates(iteration)) {
    const executionVariant = variantKeyedCaseIds.has(caseId)
      ? executionVariantOf(iteration)
      : undefined;
    const aggregationKey = evalCaseAggregationKey({
      caseId,
      ...(executionVariant ? { executionVariant } : {}),
    });
    if (hasKey(aggregationKey)) return { caseId, aggregationKey };
  }
  return null;
}
