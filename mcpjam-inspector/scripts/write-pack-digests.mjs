/**
 * Write `pack-digests.generated.ts` from a pack build's own output.
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
 *   node scripts/write-pack-digests.mjs --version 3.4.0 \
 *     --digests '{"darwin-arm64":"sha256:…","linux-x64":"sha256:…"}'
 *
 * `--check` instead of writing compares and exits non-zero on any difference,
 * which is how a workflow asserts the checked-in table matches the packs a
 * release is about to publish.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const inspectorRoot = join(scriptDir, "..");
const GENERATED = join(
  inspectorRoot,
  "server/utils/harness/local/pack-digests.generated.ts",
);

/** The targets a pack is built for. Must match `LocalPackTarget`. */
const TARGETS = [
  "darwin-arm64",
  "darwin-x64",
  "linux-x64",
  "linux-arm64",
  "win32-x64",
];

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

const args = parseArgs(process.argv.slice(2));
const version = String(args.version ?? "").trim();
if (version.length === 0) fail("--version is required");
// The version reaches an asset URL and a directory name, so it is checked
// rather than trusted: this runs in a workflow whose input a person types.
if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(version)) {
  fail(`--version ${JSON.stringify(version)} is not a release version`);
}

let digests;
try {
  digests = JSON.parse(String(args.digests ?? ""));
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

const treeDigests = entries
  .map(
    ([target, digest]) =>
      `    ${JSON.stringify(target)}: ${JSON.stringify(digest)},`,
  )
  .join("\n");
const records = entries
  .map(
    ([target, digest]) =>
      `    ${JSON.stringify(target)}: {\n` +
      `      packVersion: ${JSON.stringify(version)},\n` +
      `      treeDigest: ${JSON.stringify(digest)},\n` +
      `    },`,
  )
  .join("\n");

/**
 * Rewrite one `export const … = { … };` block.
 *
 * Fails rather than no-ops when the pattern does not match: a silent miss here
 * would leave a release's digest table empty while every step reported
 * success, which is the failure mode this whole script exists to remove.
 */
function replaceBlock(text, pattern, replacement, what) {
  if (!pattern.test(text)) {
    fail(`could not find ${what} in the generated file; its shape moved`);
  }
  return text.replace(pattern, replacement);
}

const source = readFileSync(GENERATED, "utf8");
let next = replaceBlock(
  source,
  /(export const PACK_TREE_DIGESTS[\s\S]*?= \{\n)([\s\S]*?)(^\};$)/m,
  `$1  "claude-code": {\n${treeDigests}\n  },\n  codex: {},\n$3`,
  "PACK_TREE_DIGESTS",
);
next = replaceBlock(
  next,
  /(export const PACK_RECORDS[\s\S]*?= \{\n)([\s\S]*?)(^\};$)/m,
  `$1  "claude-code": {\n${records}\n  },\n  codex: {},\n$3`,
  "PACK_RECORDS",
);
next = replaceBlock(
  next,
  /^export const EXPECTED_PACK_VERSION = .*$/m,
  `export const EXPECTED_PACK_VERSION = ${JSON.stringify(version)};`,
  "EXPECTED_PACK_VERSION",
);

if (args.check === true) {
  if (next !== source) {
    console.error(
      "write-pack-digests: the checked-in digest table does not match the " +
        "packs this build produced.\n" +
        "Regenerate it and commit the result:\n" +
        `  node scripts/write-pack-digests.mjs --version ${version} \\\n` +
        `    --digests '${JSON.stringify(Object.fromEntries(entries))}'`,
    );
    process.exit(1);
  }
  console.log("write-pack-digests: the committed table matches these packs");
} else {
  writeFileSync(GENERATED, next);
  console.log(
    `write-pack-digests: wrote ${entries.length} target(s) at version ${version}`,
  );
}
