// Read and write the committed runtime compatibility record
// (`server/utils/harness/local/runtime-compat.generated.json`) — and read the
// release-relevant facts out of each harness's compatibility manifest entry —
// without a TypeScript loader.
//
// Shared by `write-pack-digests.mjs` (which rewrites one harness's entries),
// `check-local-harness-release.mjs` (which reads every harness's) and the
// publication workflow, so they cannot disagree about the file's shape.
// `release-gate.test.ts` pins this reader to the TypeScript one
// (`runtime-compat.ts`), which validates the same rules at import.
//
// The record used to be TypeScript, parsed back out with regexes. It is JSON
// now precisely so that nothing here has to know how a TypeScript literal is
// laid out.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const TARGETS = ["darwin-arm64", "darwin-x64", "linux-x64", "linux-arm64", "win32-x64"];
export const PACK_TABLE_TARGETS = TARGETS;

const scriptDir = dirname(fileURLToPath(import.meta.url));
/** Where the record lives. */
export const RUNTIME_COMPAT_PATH = join(
  scriptDir,
  "../server/utils/harness/local/runtime-compat.generated.json",
);

const DIGEST = /^sha256:[0-9a-f]{64}$/;
const VERSION = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/;
const GENERATED_BY = "scripts/write-pack-digests.mjs — do not edit by hand";

function packRef(value, label) {
  if (
    value === null ||
    typeof value !== "object" ||
    typeof value.packVersion !== "string" ||
    !VERSION.test(value.packVersion) ||
    typeof value.treeDigest !== "string" ||
    !DIGEST.test(value.treeDigest)
  ) {
    throw new Error(`runtime-compat.generated.json: ${label} is not a pack reference`);
  }
  return { packVersion: value.packVersion, treeDigest: value.treeDigest };
}

/** Parse and validate the record's text. Mirrors `parseRuntimeCompatRecord`. */
export function parseRuntimeCompat(text) {
  const raw = JSON.parse(text);
  if (raw === null || typeof raw !== "object" || raw.schema !== 1) {
    throw new Error("runtime-compat.generated.json: unknown schema");
  }
  const harnesses = {};
  for (const [harnessId, entry] of Object.entries(raw.harnesses ?? {})) {
    if (typeof entry?.conformance?.version !== "string") {
      throw new Error(`runtime-compat.generated.json: ${harnessId} has no conformance version`);
    }
    const targets = {};
    for (const [target, slot] of Object.entries(entry.targets ?? {})) {
      if (!TARGETS.includes(target)) {
        throw new Error(`runtime-compat.generated.json: ${harnessId} names unknown target ${target}`);
      }
      const desired = packRef(slot.desired, `${harnessId} ${target} desired`);
      const permitted =
        slot.permitted === undefined ? undefined : packRef(slot.permitted, `${harnessId} ${target} permitted`);
      if (permitted && (permitted.treeDigest === desired.treeDigest || permitted.packVersion === desired.packVersion)) {
        throw new Error(`runtime-compat.generated.json: ${harnessId} ${target} permits the desired pack as its own previous`);
      }
      targets[target] = { desired, ...(permitted ? { permitted } : {}) };
    }
    harnesses[harnessId] = {
      conformance: {
        version: entry.conformance.version,
        ...(typeof entry.conformance.evidence === "string" ? { evidence: entry.conformance.evidence } : {}),
      },
      targets,
    };
  }
  return { schema: 1, harnesses };
}

/** The committed record, read from disk. */
export function readRuntimeCompat(path = RUNTIME_COMPAT_PATH) {
  return parseRuntimeCompat(readFileSync(path, "utf8"));
}

/** Canonical text: sorted harnesses and targets, two-space JSON, newline. */
export function renderRuntimeCompat(record) {
  const harnesses = {};
  for (const harnessId of Object.keys(record.harnesses).sort()) {
    const entry = record.harnesses[harnessId];
    const targets = {};
    for (const target of Object.keys(entry.targets).sort()) {
      const slot = entry.targets[target];
      targets[target] = {
        desired: { packVersion: slot.desired.packVersion, treeDigest: slot.desired.treeDigest },
        ...(slot.permitted
          ? { permitted: { packVersion: slot.permitted.packVersion, treeDigest: slot.permitted.treeDigest } }
          : {}),
      };
    }
    harnesses[harnessId] = {
      conformance: {
        version: entry.conformance.version,
        ...(entry.conformance.evidence ? { evidence: entry.conformance.evidence } : {}),
      },
      targets,
    };
  }
  return `${JSON.stringify({ schema: 1, generatedBy: GENERATED_BY, harnesses }, null, 2)}\n`;
}

/**
 * Every harness's committed pack state, in the shape the release scripts have
 * always consumed:
 * `{ [harnessId]: { version, digests, records, permitted, conformance, evidence? } }`
 * where `version`/`digests`/`records` describe the DESIRED pack and
 * `permitted` maps target to the permitted previous pack, where one is pinned.
 */
export function parsePackTables(text) {
  const record = parseRuntimeCompat(text);
  const state = {};
  for (const [harnessId, entry] of Object.entries(record.harnesses)) {
    const digests = {};
    const records = {};
    const permitted = {};
    let version = "";
    for (const [target, slot] of Object.entries(entry.targets)) {
      digests[target] = slot.desired.treeDigest;
      records[target] = { ...slot.desired };
      version = slot.desired.packVersion;
      if (slot.permitted) permitted[target] = { ...slot.permitted };
    }
    state[harnessId] = {
      version,
      digests,
      records,
      permitted,
      conformance: entry.conformance.version,
      ...(entry.conformance.evidence ? { evidence: entry.conformance.evidence } : {}),
    };
  }
  return state;
}

/**
 * Pin a new DESIRED pack for ONE harness and re-render the record. Every other
 * harness is carried over exactly as parsed. Throws if the harness is not
 * already in the record: which harnesses exist is decided by
 * `SupportedLocalHarnessId`, not here.
 *
 * `options.permitPrevious`: the previous desired pack of each target becomes
 * that target's `permitted` previous (replacing any older one — at most one is
 * ever kept). Only pass it once conformance has passed for this build's layer
 * against BOTH packs; without it the previous pack is no longer selectable.
 * Re-pinning the same version is a no-op for `permitted`, so the call is
 * idempotent.
 *
 * `options.conformance` / `options.evidence`: replace the recorded conformance
 * stamp and the link to the run behind it.
 */
export function rewriteHarnessPackTables(text, harnessId, version, digests, options = {}) {
  const record = parseRuntimeCompat(text);
  const entry = record.harnesses[harnessId];
  if (entry === undefined) {
    throw new Error(`the runtime compatibility record has no ${harnessId} entry to rewrite`);
  }
  if (!VERSION.test(version)) throw new Error(`${version} is not a pack version`);
  const targets = {};
  for (const [target, treeDigest] of Object.entries(digests).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    if (!TARGETS.includes(target)) throw new Error(`unknown pack target ${target}`);
    if (!DIGEST.test(treeDigest)) throw new Error(`digest for ${target} is not a sha256 tree digest`);
    const previous = entry.targets[target];
    const desired = { packVersion: version, treeDigest };
    let permitted;
    if (previous && previous.desired.packVersion === version && previous.desired.treeDigest === treeDigest) {
      // Same pin again: keep whatever was already permitted.
      permitted = previous.permitted;
    } else if (options.permitPrevious && previous && previous.desired.packVersion !== version) {
      permitted = previous.desired;
    }
    targets[target] = { desired, ...(permitted ? { permitted } : {}) };
  }
  record.harnesses[harnessId] = {
    conformance: {
      version: options.conformance ?? entry.conformance.version,
      ...((options.evidence ?? entry.conformance.evidence)
        ? { evidence: options.evidence ?? entry.conformance.evidence }
        : {}),
    },
    targets,
  };
  return renderRuntimeCompat(record);
}

/** Two-space-indented `"id": { ... },` or `id: { ... },` entries. */
function harnessEntries(body) {
  const entries = new Map();
  const pattern = /^ {2}"?([a-z][a-z0-9-]*)"?: \{(?:\},$|\n([\s\S]*?)^ {2}\},$)/gm;
  for (const match of body.matchAll(pattern)) {
    entries.set(match[1], match[2] ?? "");
  }
  return entries;
}

/**
 * The release-relevant REVIEWED-POLICY fields of every harness's compatibility
 * manifest: `{ [harnessId]: { nativePlatforms, nativeTargets? } }`, where
 * `nativeTargets` (D8) is present only when the manifest narrows to exact pack
 * targets. Conformance is no longer typed into the manifest; it comes from the
 * generated record (`parsePackTables(...)[id].conformance`).
 */
export function parseManifestFacts(compatSource) {
  const start = compatSource.indexOf("export const LOCAL_HARNESS_MANIFEST");
  if (start < 0) throw new Error("could not find LOCAL_HARNESS_MANIFEST in compatibility.ts");
  const open = compatSource.indexOf("= {\n", start);
  const close = compatSource.indexOf("\n};", open);
  const body = `${compatSource.slice(open + 4, close)}\n`;
  const facts = {};
  for (const [id, block] of harnessEntries(body)) {
    const list = (name) => {
      const match = block.match(new RegExp(`\\n {4}${name}: \\[([^\\]]*)\\]`));
      if (!match) return undefined;
      return match[1]
        .split(",")
        .map((token) => token.trim().replace(/^"|"$/g, ""))
        .filter((token) => token.length > 0);
    };
    const nativeTargets = list("nativeTargets");
    facts[id] = {
      nativePlatforms: list("nativePlatforms") ?? [],
      ...(nativeTargets !== undefined ? { nativeTargets } : {}),
    };
  }
  return facts;
}

/** The pack targets each native platform needs. */
export const TARGETS_BY_PLATFORM = {
  darwin: ["darwin-arm64", "darwin-x64"],
  linux: ["linux-x64", "linux-arm64"],
  win32: ["win32-x64"],
};

/** Every target a harness's manifest advertises, narrowed per D8 (`nativeTargets`). */
export function advertisedTargetsOf(facts) {
  return (facts?.nativePlatforms ?? [])
    .flatMap((platform) => TARGETS_BY_PLATFORM[platform] ?? [])
    .filter((target) => !facts.nativeTargets || facts.nativeTargets.includes(target));
}

/** The targets one harness advertises, read from the committed `compatibility.ts`. */
export function readAdvertisedTargets(harnessId) {
  const source = readFileSync(join(scriptDir, "../server/utils/harness/local/compatibility.ts"), "utf8");
  return advertisedTargetsOf(parseManifestFacts(source)[harnessId]);
}
