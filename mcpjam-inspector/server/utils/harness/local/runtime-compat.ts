/**
 * The runtime compatibility record: which vendor packs THIS Inspector build
 * may run, per harness and pack target.
 *
 * ── What it replaces ─────────────────────────────────────────────────────
 * The pinned digests used to be a hand-maintained TypeScript table plus a
 * hand-typed `lifecycleConformanceVersion` stamp in `compatibility.ts`, and
 * scripts parsed both back out of the TypeScript with regexes. One generated
 * JSON file (`runtime-compat.generated.json`) now carries all of it, written by
 * `scripts/write-pack-digests.mjs` (which `prepare-release.yml` runs for each pin),
 * reviewed in a diff, and read here and by every script without a parser for
 * TypeScript source.
 *
 * ── Desired and permitted ────────────────────────────────────────────────
 * Per harness and target, at most two packs:
 *
 *   - `desired`: the pack this build wants. New sessions run it as soon as it
 *     is installed, verified and healthy.
 *   - `permitted`: at most ONE previous pack this build was tested against
 *     (conformance passed for this build's Inspector layer × that pack). It is
 *     what a session runs while the desired pack is still downloading, or after
 *     the desired pack proved unhealthy on this machine.
 *
 * Nothing else is ever selected (invariant 4). A pack on the revocation list is
 * never selected even when it is named here (see `runtime-selection.ts`).
 *
 * The file is validated on load. It is generated and reviewed, so a malformed
 * record is a build defect, and failing at import is better than a selection
 * that quietly reads `undefined` as "no pack".
 */
import record from "./runtime-compat.generated.json" with { type: "json" };
import type { LocalPackTarget, SupportedLocalHarnessId } from "./targets.js";

/** One published pack, as a build pins it. */
export interface RuntimePackRef {
  packVersion: string;
  /** Canonical tree digest, `sha256:<hex>`. */
  treeDigest: string;
}

export interface RuntimeCompatTarget {
  desired: RuntimePackRef;
  permitted?: RuntimePackRef;
}

export interface RuntimeCompatHarness {
  /**
   * The lifecycle conformance evidence behind this harness's offer. Empty
   * `version` = no evidence, which `resolveLocalCompatibility` refuses.
   */
  conformance: { version: string; evidence?: string };
  targets: Readonly<Partial<Record<LocalPackTarget, RuntimeCompatTarget>>>;
}

export interface RuntimeCompatRecord {
  schema: 1;
  harnesses: Readonly<Record<SupportedLocalHarnessId, RuntimeCompatHarness>>;
}

const DIGEST = /^sha256:[0-9a-f]{64}$/;
const VERSION = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/;
const TARGETS: readonly LocalPackTarget[] = [
  "darwin-arm64",
  "darwin-x64",
  "linux-x64",
  "linux-arm64",
  "win32-x64",
];

function validPackRef(value: unknown, label: string): RuntimePackRef {
  const ref = value as Partial<RuntimePackRef> | null;
  if (
    ref === null ||
    typeof ref !== "object" ||
    typeof ref.packVersion !== "string" ||
    !VERSION.test(ref.packVersion) ||
    typeof ref.treeDigest !== "string" ||
    !DIGEST.test(ref.treeDigest)
  ) {
    throw new Error(`runtime-compat.generated.json: ${label} is not a pack reference`);
  }
  return { packVersion: ref.packVersion, treeDigest: ref.treeDigest };
}

/**
 * Parse and validate a record. Exported so tests (and the scripts' twin in
 * `local-harness-pack-tables.mjs`) can exercise the same rules on fixtures.
 */
export function parseRuntimeCompatRecord(raw: unknown): RuntimeCompatRecord {
  const value = raw as { schema?: unknown; harnesses?: unknown } | null;
  if (value === null || typeof value !== "object" || value.schema !== 1) {
    throw new Error("runtime-compat.generated.json: unknown schema");
  }
  const harnesses: Record<string, RuntimeCompatHarness> = {};
  for (const [harnessId, entry] of Object.entries(
    (value.harnesses ?? {}) as Record<string, unknown>,
  )) {
    const harness = entry as {
      conformance?: { version?: unknown; evidence?: unknown };
      targets?: Record<string, unknown>;
    };
    if (typeof harness?.conformance?.version !== "string") {
      throw new Error(
        `runtime-compat.generated.json: ${harnessId} has no conformance version`,
      );
    }
    const targets: Partial<Record<LocalPackTarget, RuntimeCompatTarget>> = {};
    for (const [target, slot] of Object.entries(harness.targets ?? {})) {
      if (!(TARGETS as readonly string[]).includes(target)) {
        throw new Error(
          `runtime-compat.generated.json: ${harnessId} names unknown target ${target}`,
        );
      }
      const pair = slot as { desired?: unknown; permitted?: unknown };
      const desired = validPackRef(pair.desired, `${harnessId} ${target} desired`);
      const permitted =
        pair.permitted === undefined
          ? undefined
          : validPackRef(pair.permitted, `${harnessId} ${target} permitted`);
      if (
        permitted !== undefined &&
        (permitted.treeDigest === desired.treeDigest ||
          permitted.packVersion === desired.packVersion)
      ) {
        throw new Error(
          `runtime-compat.generated.json: ${harnessId} ${target} permits the ` +
            `desired pack as its own previous`,
        );
      }
      targets[target as LocalPackTarget] = {
        desired,
        ...(permitted !== undefined ? { permitted } : {}),
      };
    }
    const versions = new Set(
      Object.values(targets).map((slot) => slot!.desired.packVersion),
    );
    if (versions.size > 1) {
      // One release builds every target from one recipe; two desired versions
      // across targets would be two recipes shipped under one pin.
      throw new Error(
        `runtime-compat.generated.json: ${harnessId} desires more than one ` +
          `pack version across targets (${[...versions].join(", ")})`,
      );
    }
    harnesses[harnessId] = {
      conformance: {
        version: harness.conformance.version,
        ...(typeof harness.conformance.evidence === "string"
          ? { evidence: harness.conformance.evidence }
          : {}),
      },
      targets,
    };
  }
  return {
    schema: 1,
    harnesses: harnesses as Record<SupportedLocalHarnessId, RuntimeCompatHarness>,
  };
}

/** This build's record. */
export const RUNTIME_COMPAT: RuntimeCompatRecord = parseRuntimeCompatRecord(record);

function harnessEntry(
  harnessId: SupportedLocalHarnessId,
): RuntimeCompatHarness | undefined {
  return Object.prototype.hasOwnProperty.call(RUNTIME_COMPAT.harnesses, harnessId)
    ? RUNTIME_COMPAT.harnesses[harnessId]
    : undefined;
}

/** The pack this build wants for a target, or `null` when none is pinned. */
export function desiredPackFor(
  harnessId: SupportedLocalHarnessId,
  target: LocalPackTarget,
): RuntimePackRef | null {
  return harnessEntry(harnessId)?.targets[target]?.desired ?? null;
}

/** The one previous pack this build was tested against, or `null`. */
export function permittedPackFor(
  harnessId: SupportedLocalHarnessId,
  target: LocalPackTarget,
): RuntimePackRef | null {
  return harnessEntry(harnessId)?.targets[target]?.permitted ?? null;
}

/**
 * Every pack this build may select for a target, desired first. Revocation is
 * applied by the caller (`runtime-selection.ts`), which has the fetched list.
 */
export function compatiblePacksFor(
  harnessId: SupportedLocalHarnessId,
  target: LocalPackTarget,
): Array<RuntimePackRef & { role: "desired" | "permitted" }> {
  const desired = desiredPackFor(harnessId, target);
  if (desired === null) return [];
  const permitted = permittedPackFor(harnessId, target);
  return [
    { ...desired, role: "desired" },
    ...(permitted !== null ? [{ ...permitted, role: "permitted" as const }] : []),
  ];
}

/** The recorded conformance stamp; "" when no evidence is recorded. */
export function conformanceVersionFor(harnessId: SupportedLocalHarnessId): string {
  return harnessEntry(harnessId)?.conformance.version ?? "";
}
