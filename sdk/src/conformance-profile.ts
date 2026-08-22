/**
 * The conformance PROFILE: the frozen set of check ids a score is computed
 * over, plus the identity stamp that says which set a given number came from.
 *
 * WHY A PROFILE AND NOT JUST A VERSION NUMBER.
 *
 * `MCPConformanceResult` used to record `protocolVersion` and the check
 * results, and nothing else. That makes two scores from two builds
 * incomparable BY CONSTRUCTION, for two independent reasons:
 *
 *   1. The DENOMINATOR floats with the server's advertised surface. A server
 *      that starts advertising `resources` makes more checks applicable, so
 *      `13/13` and `15/15` are both "100%" of different questions. Nothing in
 *      the result said which questions were asked.
 *   2. The check INVENTORY grows. Adding a MUST check is the correct response
 *      to reading the spec more carefully, but it silently re-grades every
 *      server that was previously green — the score moved because we learned
 *      something, not because the server changed. `protocolVersion +
 *      checkerVersion` cannot separate those two: both change for both
 *      reasons.
 *
 * A profile fixes (2) and makes (1) legible. It is a per-revision manifest of
 * the check ids that COUNT toward a score. A check outside the manifest still
 * runs, still appears in the report, and still shows a real verdict — but it
 * lands in the {@link ConformanceScore.pending} bucket and is excluded from
 * `applicable`, so it can neither move a number nor fail a build. It becomes
 * scored only when a NEW profile version says so, which is a deliberate,
 * reviewable act rather than a side effect of merging a check.
 *
 * That is what makes a run comparable to the previous one: same profile
 * version ⇒ same questions asked ⇒ the delta is the server's.
 *
 * SELF-DESCRIBING ON PURPOSE. The stamp carries `pendingCheckIds`, so a
 * serialized result partitions the same way for any reader — including a
 * stored report opened by a build that never heard of this profile version.
 * The registry below is the authority at WRITE time; the stamp is the
 * authority at READ time. A result with no stamp has no pending bucket at all,
 * which is byte-identical to the pre-profile behavior.
 *
 * Pure data reasoning — no MCP client, no transport, no Node built-ins — so it
 * is exported from the browser entry alongside the score and the catalog.
 */

import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";
import { MCP_CHECK_IDS, type MCPCheckId } from "./mcp-conformance/types.js";
import {
  MCP_TASKS_CHECK_IDS,
  type MCPTasksCheckId,
} from "./tasks-conformance/types.js";

/** Injected by tsup/vitest `define` (see `sdk/tsup.config.ts`). */
declare const __MCPJAM_SDK_VERSION__: string;

/**
 * Read the injected version WITHOUT assuming the injection happened.
 *
 * This module is reachable from the browser entry, and the inspector's Vite
 * build aliases `@mcpjam/sdk/browser` straight to `src/browser.ts` — so it
 * compiles this file from SOURCE, with no `define` of its own. A bare
 * `__MCPJAM_SDK_VERSION__` reference then survives into the client bundle as an
 * undeclared global and throws `ReferenceError` at module init, which takes the
 * whole app down before React mounts. (It did: every Playwright smoke test
 * failed on a missing app shell.)
 *
 * `typeof` on an undeclared identifier is the one read that cannot throw, so a
 * consumer that bundles this from source degrades to `"unknown"` instead of
 * crashing. `"unknown"` is deliberate rather than a plausible-looking version:
 * a stamp claiming a version nobody injected would be worse than one admitting
 * it does not know.
 */
function readSdkVersion(): string {
  return typeof __MCPJAM_SDK_VERSION__ === "string"
    ? __MCPJAM_SDK_VERSION__
    : "unknown";
}

/**
 * The build that produced a result. Distinct from the profile version on
 * purpose: a patch that fixes a check's ASSERTION moves this and not the
 * profile, and that difference is exactly what a reader needs to tell "the
 * server changed" from "we fixed a false positive".
 */
export const CONFORMANCE_CHECKER_VERSION = readSdkVersion();

/**
 * Profiles are per-SUITE, because the suites have independent inventories and
 * independent reasons to move. Pooling them under one id would make a tasks
 * check addition bump the protocol denominator.
 */
export const CONFORMANCE_PROFILE_IDS = ["mcp-protocol", "mcp-tasks"] as const;

export type ConformanceProfileId = (typeof CONFORMANCE_PROFILE_IDS)[number];

export interface ConformanceProfile {
  id: ConformanceProfileId;
  /**
   * Monotonic, human-readable revision. Dated rather than a bare integer so a
   * report says WHEN the requirement set was frozen without a lookup table.
   */
  version: string;
  /**
   * The frozen manifest: every check id this profile version SCORES. Order is
   * irrelevant to membership but is canonicalized for the digest.
   */
  scored: readonly string[];
}

/**
 * `mcp-protocol` v2026-08-21.1 — the 36 checks shipping before the
 * conformance-gap program's new checks land.
 *
 * FROZEN AT EXACTLY TODAY'S POOL, deliberately. Every check the gap program
 * adds (wire-schema validation, the SEP-2243 header cases, the split caching
 * and SEP-2164 assertions) is absent from this list, so each lands `pending`
 * and no server's score moves as it merges. Promoting them is a separate,
 * reviewable profile version — which is the entire mechanism this module
 * exists to provide.
 *
 * Spelled as literals rather than `[...MCP_CHECK_IDS]`. A spread would make
 * the manifest track the inventory automatically, which is the exact drift the
 * profile exists to prevent: every future check would silently arrive scored.
 */
const MCP_PROTOCOL_PROFILE: ConformanceProfile = {
  id: "mcp-protocol",
  version: "2026-08-21.1",
  scored: [
    "server-initialize",
    "ping",
    "logging-set-level",
    "completion-complete",
    "capabilities-consistent",
    "tools-list",
    "tools-input-schemas-valid",
    "tools-x-mcp-header-declarations-valid",
    "prompts-list",
    "resources-list",
    "protocol-invalid-method-error",
    "localhost-host-rebinding-rejected",
    "localhost-host-valid-accepted",
    "server-sse-polling-session",
    "server-accepts-multiple-post-streams",
    "server-sse-streams-functional",
    "notification-post-accepted",
    "get-stream-or-405",
    "session-id-visible-ascii",
    "post-response-content-type",
    "modern-client-handshake",
    "modern-server-discover",
    "modern-result-type-present",
    "modern-cacheable-result-hints",
    "modern-protocol-version-header-mismatch",
    "modern-method-header-mismatch",
    "modern-name-header-mismatch",
    "modern-unsupported-version-error",
    "modern-undeclared-capability-error",
    "modern-no-session-id",
    "modern-removed-methods-not-found",
    "modern-resource-not-found-invalid-params",
    "modern-logs-require-log-level",
    "modern-subscription-ack-precedes-notifications",
    "modern-subscription-filter-and-tagging",
    "modern-subscription-graceful-close",
  ] satisfies MCPCheckId[],
};

/**
 * `mcp-tasks` v2026-08-22.1 — the eight checks the Tasks suite shipped before
 * the gap program's scenario depth.
 *
 * A SEPARATE profile rather than a section of `mcp-protocol`, which was the
 * open design question. Two reasons settled it:
 *
 *   - The inventories move for unrelated reasons. Adding a tasks scenario would
 *     otherwise bump the protocol denominator, so a server that never
 *     implemented the extension would see its protocol score's meaning change
 *     because we learned something about tasks. That is the exact coupling the
 *     profile exists to break.
 *   - The suites already score separately (`scoreFromTasksResult` vs
 *     `scoreFromProtocolResult`) and pool afterwards. One profile per suite
 *     matches the arithmetic that already exists rather than fighting it.
 */
const MCP_TASKS_PROFILE: ConformanceProfile = {
  id: "mcp-tasks",
  version: "2026-08-22.1",
  scored: [
    "tasks-wire-resolvable",
    "tasks-declaration-hygiene",
    "tasks-result-type-discipline",
    "tasks-undeclared-creation-refused",
    "tasks-undeclared-capability-rejected",
    "tasks-ttl-shape",
    "tasks-inline-result",
    "tasks-mcp-name-routing",
  ] satisfies MCPTasksCheckId[],
};

const PROFILES: Record<ConformanceProfileId, ConformanceProfile> = {
  "mcp-protocol": MCP_PROTOCOL_PROFILE,
  "mcp-tasks": MCP_TASKS_PROFILE,
};

export function conformanceProfile(
  id: ConformanceProfileId,
): ConformanceProfile {
  return PROFILES[id];
}

/**
 * SHA-256 over the canonical manifest text. Two builds that claim the same
 * `profileId`/`profileVersion` but disagree about the scored set produce
 * different digests, which is the only way a reader can catch a manifest that
 * was edited without a version bump.
 *
 * Ids are sorted so the digest states MEMBERSHIP, not authoring order — a
 * re-ordered manifest is the same requirement set and must not read as a
 * different one.
 */
function computeManifestDigest(profile: ConformanceProfile): string {
  const canonical = JSON.stringify({
    id: profile.id,
    version: profile.version,
    scored: [...profile.scored].sort(),
  });
  return bytesToHex(sha256(utf8ToBytes(canonical)));
}

/**
 * Keyed on the profile OBJECT, not on its id. Keying by id would hand a
 * caller the registered profile's digest for a differently-populated manifest
 * that happens to share the id — which is precisely the drift this digest
 * exists to detect.
 */
const digestCache = new WeakMap<ConformanceProfile, string>();

export function conformanceProfileDigest(
  profile: ConformanceProfile,
): string {
  const cached = digestCache.get(profile);
  if (cached !== undefined) {
    return cached;
  }
  const digest = computeManifestDigest(profile);
  digestCache.set(profile, digest);
  return digest;
}

/**
 * The identity a run stamps onto its result: which questions were asked, by
 * which build, against which revisions and schemas.
 *
 * Every field is additive over the pre-profile result shape, and the whole
 * object is optional — a consumer that predates it (the CLI reporters, the
 * inspector panels, the hand-mirrored backend summary) keeps working unchanged,
 * and a stored report written before this existed still renders.
 */
export interface ConformanceProfileStamp {
  profileId: ConformanceProfileId;
  profileVersion: string;
  /** @see {@link conformanceProfileDigest} */
  manifestDigest: string;
  /** @see {@link CONFORMANCE_CHECKER_VERSION} */
  checkerVersion: string;
  /** The revision the run judged against, when it established one. */
  protocolVersion?: string;
  /**
   * Extension id → the version the run negotiated, for extensions that were in
   * play. An extension changes what a result is allowed to look like, so a
   * score computed with one negotiated is not the same measurement as one
   * without.
   */
  extensionVersions?: Record<string, string>;
  /**
   * Digest of the wire schemas the run validated against. Set by the
   * wire-schema check; absent when the run performed no schema validation.
   */
  schemaDigest?: string;
  /**
   * Check ids present in the result that this profile version does NOT score.
   * Read at scoring time so the partition is reproducible from the result
   * alone. Empty array ⇒ every reported check was scored.
   */
  pendingCheckIds: string[];
}

/** The minimum a check must expose to be partitioned against a profile. */
export interface ProfileCheckLike {
  id: string;
}

/**
 * Which of `checks` this profile scores, and which are pending.
 *
 * Used at WRITE time (the runner, which holds the manifest). Read-time callers
 * use {@link partitionByStamp}, which needs only the serialized result.
 */
export function partitionByProfile<T extends ProfileCheckLike>(
  checks: readonly T[],
  profile: ConformanceProfile,
): { scored: T[]; pending: T[] } {
  const manifest = new Set<string>(profile.scored);
  const scored: T[] = [];
  const pending: T[] = [];
  for (const check of checks) {
    (manifest.has(check.id) ? scored : pending).push(check);
  }
  return { scored, pending };
}

/**
 * Which of `checks` a stamped result scores, and which are pending.
 *
 * An absent stamp means the result predates profiles: everything is scored and
 * nothing is pending, which reproduces the pre-profile arithmetic exactly.
 */
export function partitionByStamp<T extends ProfileCheckLike>(
  checks: readonly T[],
  stamp: Pick<ConformanceProfileStamp, "pendingCheckIds"> | undefined,
): { scored: T[]; pending: T[] } {
  if (!stamp || stamp.pendingCheckIds.length === 0) {
    return { scored: [...checks], pending: [] };
  }
  const pendingIds = new Set(stamp.pendingCheckIds);
  const scored: T[] = [];
  const pending: T[] = [];
  for (const check of checks) {
    (pendingIds.has(check.id) ? pending : scored).push(check);
  }
  return { scored, pending };
}

/**
 * Build the stamp for a run. `checks` is whatever the run reported, so the
 * pending list names the ids that were actually present rather than every id
 * the inventory could produce.
 */
export function buildConformanceProfileStamp(input: {
  profile: ConformanceProfile;
  checks: readonly ProfileCheckLike[];
  protocolVersion?: string;
  extensionVersions?: Record<string, string>;
  schemaDigest?: string;
}): ConformanceProfileStamp {
  const { pending } = partitionByProfile(input.checks, input.profile);
  return {
    profileId: input.profile.id,
    profileVersion: input.profile.version,
    manifestDigest: conformanceProfileDigest(input.profile),
    checkerVersion: CONFORMANCE_CHECKER_VERSION,
    ...(input.protocolVersion !== undefined
      ? { protocolVersion: input.protocolVersion }
      : {}),
    ...(input.extensionVersions !== undefined
      ? { extensionVersions: input.extensionVersions }
      : {}),
    ...(input.schemaDigest !== undefined
      ? { schemaDigest: input.schemaDigest }
      : {}),
    // Sorted so two runs over the same server produce byte-identical stamps —
    // a diff of two JSON reports should show only what actually differed.
    pendingCheckIds: pending.map((check) => check.id).sort(),
  };
}

/** The full inventory a profile is drawn from, for the drift assertions. */
const INVENTORIES: Record<ConformanceProfileId, readonly string[]> = {
  "mcp-protocol": MCP_CHECK_IDS,
  "mcp-tasks": MCP_TASKS_CHECK_IDS,
};

/** Every check id the profile's inventory can produce that it does not score. */
export function unscoredCheckIds(profile: ConformanceProfile): string[] {
  const manifest = new Set<string>(profile.scored);
  return INVENTORIES[profile.id].filter((id) => !manifest.has(id));
}
