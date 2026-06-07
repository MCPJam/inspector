/**
 * Build the wire pair `{ hostConfig, hostConfigHash }` for SDK→backend eval
 * ingestion from a `HostJson` or canonical `HostConfigInputV2` source.
 *
 * Pipeline (Stage 5):
 *   1. `normalizeSdkEvalHostConfigForWire` (Step 1) — strip runtime-manager
 *      identifiers (`serverIds`, `optionalServerIds`,
 *      `serverConnectionOverrides`); project public `HostJson` to canonical
 *      input shape if needed.
 *   2. `canonicalizeHostConfigV2`  — sort keys, drop SDK defaults, normalize
 *      derived fields.
 *   3. `computeHostConfigHashV2`   — sha256 of the canonical JSON bytes.
 *
 * The backend (Step 2) runs the SAME pipeline server-side and rejects on
 * hash mismatch. Producing the pair here using these exact helpers
 * guarantees the byte-stable input on both sides.
 */

import {
  computeHostConfigHashV2,
  normalizeSdkEvalHostConfigForWire,
} from "./host-config/internal.js";
import type { HostConfigInputV2 } from "./host-config/internal.js";
import type { HostJson } from "./host-config/public-types.js";

/**
 * Wire-ready host-config pair for `/sdk/v1/evals/*` request bodies.
 *
 * Both fields are required together — sending one without the other is a
 * 400 from the backend. The reporter MUST inject both as an atomic pair.
 */
export interface SdkEvalsWireHostConfig {
  /** Post-normalization canonical input shape (runtime ids stripped). */
  readonly hostConfig: HostConfigInputV2;
  /** sha256 hex of the canonicalized input. */
  readonly hostConfigHash: string;
}

/**
 * Build the wire pair from a `HostJson` snapshot or canonical input.
 *
 * Pure and deterministic. Two calls with byte-equal canonical projections
 * produce the same hash. Accepting both input shapes lets callers feed
 * either `Host.toJSON()` output (public vocabulary) or an internal
 * `HostConfigInputV2` row without an explicit conversion step.
 */
export async function buildSdkEvalsWireHostConfig(
  source: HostConfigInputV2 | HostJson
): Promise<SdkEvalsWireHostConfig> {
  const normalized = normalizeSdkEvalHostConfigForWire(source);
  // `computeHostConfigHashV2` internally canonicalizes — passing the
  // normalized input directly keeps the SDK and backend on one code path.
  const hostConfigHash = await computeHostConfigHashV2(normalized);
  return { hostConfig: normalized, hostConfigHash };
}
