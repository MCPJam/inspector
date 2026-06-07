/**
 * Resolve the run-level host snapshot for SDK eval reporting (Stage 5,
 * Step 3, pass 1).
 *
 * Source priority:
 *   1. PRIMARY  — per-iteration `iteration.hostSnapshot` (Stage 4 capture).
 *   2. FALLBACK — `executor.getHostSnapshot?.()` (run-wide executor view).
 *   3. LAST     — `explicitHost.toJSON()` (caller's `MCPJamReportingConfig.host`).
 *
 * Homogeneity gate (pass 1): if SOME iterations supply a `hostSnapshot`,
 * canonicalize+hash each one. If all hashes agree, the run is homogeneous
 * and we return that snapshot. If they differ, this pass OMITS the
 * run-level wire pair — heterogeneous runs require per-iteration wire
 * support that this stage does not ship.
 *
 * Strict mode is deliberately out of scope here: we silently omit on
 * heterogeneous so that a reasonable executor configuration that happens
 * to mutate the live `Host` between iterations doesn't break eval
 * reporting today. A future stage can promote heterogeneity to either
 * a per-iteration wire field or an opt-in error.
 *
 * TODO(Stage 5+): once the backend accepts per-iteration `hostConfig`,
 * stop collapsing to a single run-level value and emit one wire pair per
 * iteration instead of omitting on heterogeneity.
 */

import { computeHostConfigHashV2 } from "./host-config/internal.js";
import { normalizeSdkEvalHostConfigForWire } from "./host-config/internal.js";
import type { HostJson } from "./host-config/public-types.js";
import type { Host } from "./host-config/host.js";

interface RunIterationLike {
  /** Per-iteration host snapshot captured at Stage 4 (optional). */
  hostSnapshot?: HostJson | undefined;
}

interface ExecutorLike {
  getHostSnapshot?(): HostJson | undefined;
}

/** Input for {@link resolveRunLevelHostSnapshot}. */
export interface ResolveRunLevelHostSnapshotInput {
  /** Iteration shapes that may carry a per-iteration host snapshot. */
  readonly iterations: readonly RunIterationLike[];
  /** Optional executor exposing `getHostSnapshot()` (HostRunner path). */
  readonly executor?: ExecutorLike;
  /** Caller-supplied override (`MCPJamReportingConfig.host`). */
  readonly explicitHost?: Host;
}

async function hashSnapshot(snapshot: HostJson): Promise<string> {
  // Use the SAME projection the reporter will eventually wire through, so
  // homogeneity here matches the actual on-wire bytes. Without the
  // normalizer, two iterations could differ only in runtime-id metadata
  // (which is stripped on the wire) and be falsely flagged heterogeneous.
  const normalized = normalizeSdkEvalHostConfigForWire(snapshot);
  return computeHostConfigHashV2(normalized);
}

/**
 * Resolve the single `HostJson` snapshot to attach to a run-level wire
 * pair, or `null` to omit the pair entirely.
 *
 * Returns `null` when:
 *   - no per-iteration snapshot AND no executor snapshot AND no explicit
 *     host;
 *   - per-iteration snapshots are heterogeneous (different canonical
 *     hashes) — pass 1 omit rather than smuggle a misleading run-level
 *     value.
 */
export async function resolveRunLevelHostSnapshot(
  input: ResolveRunLevelHostSnapshotInput
): Promise<HostJson | null> {
  const iterationSnapshots: HostJson[] = [];
  for (const iter of input.iterations) {
    if (iter.hostSnapshot) iterationSnapshots.push(iter.hostSnapshot);
  }

  if (iterationSnapshots.length > 0) {
    const first = iterationSnapshots[0]!;
    if (iterationSnapshots.length === 1) {
      return first;
    }
    const hashes = await Promise.all(iterationSnapshots.map(hashSnapshot));
    const reference = hashes[0]!;
    for (let i = 1; i < hashes.length; i++) {
      if (hashes[i] !== reference) {
        // Heterogeneous — pass 1 omit. See TODO above.
        return null;
      }
    }
    return first;
  }

  // No per-iteration snapshots: fall back to the executor view.
  const executorSnapshot = input.executor?.getHostSnapshot?.();
  if (executorSnapshot) return executorSnapshot;

  // Last resort: the caller-supplied `Host` from MCPJamReportingConfig.
  if (input.explicitHost) {
    try {
      return input.explicitHost.toJSON();
    } catch {
      // An ill-configured caller-supplied Host (e.g. missing `model`) must
      // not crash the reporter. Drop to "no snapshot" so the wire pair is
      // simply omitted.
      return null;
    }
  }

  return null;
}
