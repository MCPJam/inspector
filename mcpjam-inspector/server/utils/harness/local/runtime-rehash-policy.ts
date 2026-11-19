/**
 * Which files of a verified runtime pack are re-hashed before every spawn,
 * PER RUNTIME, as each runtime's definition declares them (`rehash` in
 * `runtimes/<harnessId>.ts`).
 *
 * Kept out of `runtime-identity.ts` on purpose. That module carries the tree
 * digest every pack is identified by, so it is a SHARED pack input: a pattern
 * edited there would change every pack's fingerprint, for bytes that cannot
 * change those packs. Nothing here changes what a pack digests as — only which
 * already-digested files are re-read later.
 */
import { LOCAL_RUNTIMES, localRuntimeOf } from "./runtimes/index.js";
import type { RuntimeRehashPolicy } from "./runtimes/types.js";
import { SUPPORTED_LOCAL_HARNESS_IDS, type SupportedLocalHarnessId } from "./targets.js";

export type { RuntimeRehashPolicy } from "./runtimes/types.js";

const BUNDLED_NODE = /^bin\/node(\.exe)?$/;

export const RUNTIME_REHASH_POLICIES = Object.fromEntries(
  SUPPORTED_LOCAL_HARNESS_IDS.map((id) => [id, LOCAL_RUNTIMES[id].rehash]),
) as Readonly<Record<SupportedLocalHarnessId, RuntimeRehashPolicy>>;

/** The policy for a harness; an id with none gets the honest default —
 *  only the bundled Node — rather than a throw at spawn. */
export function rehashPolicyFor(harnessId: string): RuntimeRehashPolicy {
  return localRuntimeOf(harnessId)?.rehash ?? { always: [], strict: [BUNDLED_NODE] };
}
