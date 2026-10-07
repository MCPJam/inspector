/**
 * Pin a pack build's output in `runtime-compat.generated.json` (the record
 * `pack-digests.generated.ts` and `compatibility.ts` read).
 *
 * The missing link in the release. `local-harness-pack.yml` builds a pack per
 * target and collects `{"<target>": "sha256:…"}`, and every Inspector build
 * refuses any pack whose tree does not hash to what this table carries — but
 * nothing wrote the table, so a release would have shipped the empty checked-in
 * one, `expectedPackFor` would answer `null`, and every published pack would
 * have been rejected as unsupported. The artifacts would exist and be
 * unusable.
 *
 * Run BEFORE the Inspector artifacts are built, so the digests are compiled
 * into them:
 *
 *   node scripts/write-pack-digests.mjs --harness claude-code --version 1.0.0 \
 *     --digests '{"darwin-arm64":"sha256:…","linux-x64":"sha256:…"}'
 *
 * `--harness` names the one harness whose entries (digests, records and
 * expected pack version) are rewritten; every other harness's entries are
 * carried over untouched, because each harness's pack is released on its own.
 * It defaults to `claude-code` for the commands already in runbooks.
 *
 * `--permit-previous` keeps the pack this pin replaces selectable as the
 * target's ONE permitted previous pack. Pass it only once conformance has passed
 * for this build's Inspector layer against both packs (the publication
 * pipeline's pin, applied by prepare-release, does exactly that); without it the previous pack is no
 * longer selectable at all.
 *
 * `--conformance <stamp>` and `--evidence <url>` record the conformance run
 * the pin rests on, replacing the stamp that used to be typed into
 * `compatibility.ts` by hand.
 *
 * `--check` instead of writing compares and exits non-zero on any difference,
 * which is how a workflow asserts the checked-in table matches the packs a
 * release is about to publish.
 */
import { readFileSync, writeFileSync } from "node:fs";
import {
  PACK_TABLE_TARGETS,
  RUNTIME_COMPAT_PATH,
  rewriteHarnessPackTables,
} from "./local-harness-pack-tables.mjs";

const GENERATED = RUNTIME_COMPAT_PATH;

/** The targets a pack is built for. Must match `LocalPackTarget`. */
const TARGETS = PACK_TABLE_TARGETS;

function fail(message) {
  console.error(`write-pack-digests: ${message}`);
  process.exit(1);
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith("--")) continue;
    const name = token.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) {
      args[name] = true;
    } else {
      args[name] = next;
      i += 1;
    }
  }
  return args;
}

/**
 * A flag's value, insisting it was actually given one.
 *
 * `--version --digests '{…}'` parses as `version: true`, and `String(true)` is
 * the perfectly plausible-looking release version `"true"` — which would have
 * been written into the table and then into every asset URL and install path.
 * A missing value is a usage error, not a value.
 */
function stringArg(name) {
  const value = args[name];
  if (value === undefined) return null;
  if (typeof value !== "string") {
    fail(`--${name} needs a value`);
  }
  return value.trim();
}

const args = parseArgs(process.argv.slice(2));

// `--check` is a FLAG. A stray value after it made `args.check` a string, the
// `=== true` below then fell through to the write branch, and a release's
// verification step would have silently rewritten the digest table it was
// supposed to be checking. Fails closed instead.
if (args.check !== undefined && args.check !== true) {
  fail("--check takes no value");
}
const checkOnly = args.check === true;

const harnessId = stringArg("harness") ?? "claude-code";
if (!/^[a-z][a-z0-9-]{0,63}$/.test(harnessId)) {
  fail(`--harness ${JSON.stringify(harnessId)} is not a harness id`);
}

const version = stringArg("version") ?? "";
if (version.length === 0) fail("--version is required");
// The version reaches an asset URL and a directory name, so it is checked
// rather than trusted: this runs in a workflow whose input a person types.
if (!/^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/.test(version)) {
  fail(`--version ${JSON.stringify(version)} is not a pack semver`);
}

for (const flag of ["permit-previous"]) {
  if (args[flag] !== undefined && args[flag] !== true) fail(`--${flag} takes no value`);
}
const permitPrevious = args["permit-previous"] === true;
const conformance = stringArg("conformance");
if (conformance !== null && !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(conformance)) {
  fail(`--conformance ${JSON.stringify(conformance)} is not a conformance stamp`);
}
const evidence = stringArg("evidence");
if (evidence !== null && !/^https:\/\/github\.com\/[^\s]+$/.test(evidence)) {
  fail("--evidence must be a https://github.com/... run URL");
}

let digests;
try {
  digests = JSON.parse(stringArg("digests") ?? "");
} catch {
  fail("--digests must be a JSON object of target to digest");
}
if (digests === null || typeof digests !== "object" || Array.isArray(digests)) {
  fail("--digests must be a JSON object of target to digest");
}

const entries = [];
for (const [target, digest] of Object.entries(digests)) {
  if (!TARGETS.includes(target)) {
    fail(`unknown pack target ${JSON.stringify(target)}`);
  }
  if (!/^sha256:[0-9a-f]{64}$/.test(String(digest))) {
    fail(`digest for ${target} is not a sha256 tree digest`);
  }
  entries.push([target, String(digest)]);
}
if (entries.length === 0) fail("--digests named no targets");
entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

const source = readFileSync(GENERATED, "utf8");
let next;
try {
  next = rewriteHarnessPackTables(
    source,
    harnessId,
    version,
    Object.fromEntries(entries),
    {
      permitPrevious,
      ...(conformance !== null ? { conformance } : {}),
      ...(evidence !== null ? { evidence } : {}),
    },
  );
} catch (error) {
  // A silent miss here would leave a release's digest table empty while every
  // step reported success, which is the failure mode this script exists to
  // remove.
  fail(error instanceof Error ? error.message : String(error));
}

if (checkOnly) {
  if (next !== source) {
    console.error(
      "write-pack-digests: the checked-in digest table does not match the " +
        "packs this build produced.\n" +
        "Regenerate it and commit the result:\n" +
        `  node scripts/write-pack-digests.mjs --harness ${harnessId} --version ${version} \\\n` +
        `    --digests '${JSON.stringify(Object.fromEntries(entries))}'`,
    );
    process.exit(1);
  }
  console.log("write-pack-digests: the committed table matches these packs");
} else {
  writeFileSync(GENERATED, next);
  console.log(
    `write-pack-digests: wrote ${entries.length} ${harnessId} target(s) at version ${version}`,
  );
}
