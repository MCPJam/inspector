import { computePackInputs } from "./check-local-harness-inputs.mjs";
/**
 * The release gate for local Claude Code execution.
 *
 * Run before a release publishes, and again after its assets exist. It refuses
 * a release that ADVERTISES a local target it cannot serve:
 *
 *   1. every platform in `nativePlatforms` has a pack digest for each of its
 *      targets, at the independently pinned pack version;
 *   2. the harness records lifecycle conformance evidence;
 *   3. (with `--assets`) each advertised target's published assets exist, its
 *      manifest is signed by the key this Inspector build carries, and the
 *      manifest's tree digest is byte-identical to the committed one.
 *
 * (3) is what makes this a RELEASE check rather than a lint. The pack workflow
 * already proves a freshly built pack installs — from a local file, through
 * `MCPJAM_LOCAL_HARNESS_PACK_SOURCE`. That is a development override, and a
 * shipped Inspector never uses it: it fetches the release asset by URL and
 * verifies against the committed digest. Only checking the published asset
 * exercises the path a user is actually on.
 *
 * Usage:
 *   node scripts/check-local-harness-release.mjs --version 3.4.0
 *   node scripts/check-local-harness-release.mjs --version 3.4.0 --assets
 *   node scripts/check-local-harness-release.mjs --version 3.4.0 --assets \
 *     --base-url file:///tmp/pack-out            # a local artifact directory
 *
 * Exits non-zero with every blocker listed, not just the first: fixing
 * conformance and then discovering the digest table is also empty is two
 * release cycles for one problem.
 */
import { createHash, createPublicKey, verify as edVerify } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const inspectorRoot = join(scriptDir, "..");

/**
 * The modules are TypeScript, and this script is plain node. Rather than pull
 * in a loader, the two facts it needs are parsed out of the sources — which
 * has the useful side effect that the check reads exactly what is COMMITTED,
 * not what a build step could have rewritten on the way past.
 */
async function readCommittedFacts() {
  const digestsSource = await readFile(
    join(
      inspectorRoot,
      "server/utils/harness/local/pack-digests.generated.ts",
    ),
    "utf8",
  );
  const compatSource = await readFile(
    join(inspectorRoot, "server/utils/harness/local/compatibility.ts"),
    "utf8",
  );

  const versionMatch = digestsSource.match(
    /export const EXPECTED_PACK_VERSION = "([^"]*)";/,
  );
  const expectedVersion = versionMatch?.[1] ?? "";

  const recordsBlock = digestsSource.match(
    /export const PACK_RECORDS[\s\S]*?= \{\n([\s\S]*?)^\};$/m,
  );
  const records = {};
  if (recordsBlock) {
    const claudeBlock = recordsBlock[1].match(
      /"claude-code": \{\n([\s\S]*?)^  \},$/m,
    );
    const body = claudeBlock?.[1] ?? "";
    const entry =
      /"([a-z0-9-]+)": \{\s*packVersion: "([^"]*)",\s*treeDigest: "([^"]*)",\s*\},/g;
    for (const match of body.matchAll(entry)) {
      records[match[1]] = { packVersion: match[2], treeDigest: match[3] };
    }
  }

  // The `claude-code` manifest's own two release-relevant fields.
  const claudeManifest = compatSource.match(
    /"claude-code": \{[\s\S]*?\n  \},\n  codex: \{/,
  );
  const manifestBody = claudeManifest?.[0] ?? "";
  const conformance =
    manifestBody.match(/lifecycleConformanceVersion: "([^"]*)"/)?.[1] ?? "";
  const nativePlatforms = (
    manifestBody.match(/nativePlatforms: \[([^\]]*)\]/)?.[1] ?? ""
  )
    .split(",")
    .map((token) => token.trim().replace(/^"|"$/g, ""))
    .filter((token) => token.length > 0);

  return { expectedVersion, records, conformance, nativePlatforms };
}

const TARGETS_BY_PLATFORM = {
  darwin: ["darwin-arm64", "darwin-x64"],
  linux: ["linux-x64", "linux-arm64"],
  win32: ["win32-x64"],
};

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith("--")) continue;
    const name = token.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) args[name] = true;
    else {
      args[name] = next;
      i += 1;
    }
  }
  return args;
}

/**
 * The public key a shipped Inspector verifies pack manifests with.
 *
 * Read from the same source file the server reads it from, so this check
 * cannot pass against a key the shipped build would reject.
 */
async function readPackSigningPublicKeys() {
  const source = await readFile(
    join(inspectorRoot, "server/utils/harness/local/pack-signing-key.ts"),
    "utf8",
  );
  // The PEM blocks verbatim, so this verifies with the same key material the
  // server does rather than with a re-encoding of it.
  return [
    ...source.matchAll(
      /-----BEGIN PUBLIC KEY-----[\s\S]*?-----END PUBLIC KEY-----/g,
    ),
  ].map((match) => match[0]);
}

async function fetchAsset(baseUrl, name) {
  const url = new URL(name, baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`);
  if (url.protocol === "file:") {
    return readFile(fileURLToPath(url));
  }
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`${url} responded ${response.status}`);
  }
  return Buffer.from(await response.arrayBuffer());
}

async function main() {
  const computedInputs = await computePackInputs();
  const recordedInputs = JSON.parse(await readFile(join(inspectorRoot, "server/utils/harness/local/pack-inputs.generated.json"), "utf8"));
  if (JSON.stringify(computedInputs) !== JSON.stringify(recordedInputs)) throw new Error("Pack inputs differ from the reviewed fingerprint. Recompute and review before releasing.");
  const args = parseArgs(process.argv.slice(2));
  const facts = await readCommittedFacts();
  const version = facts.expectedVersion;
  // Two lists, and the difference between them is the point.
  //
  // `blockers` fail the release: the build would OFFER a local target it
  // cannot serve. `notShipped` only explains why the feature is still dark —
  // a build with no conformance evidence offers local execution nowhere, so
  // it is unshipped rather than broken, and failing every release until an
  // unrelated feature lands is noise nobody keeps. `--require-ready` is how a
  // release that INTENDS to ship the feature turns the second list into the
  // first.
  const blockers = [];
  const notShipped = [];

  // Mirrors `localHarnessReleaseBlockers` in
  // `server/utils/harness/local/release-gate.ts`; `release-gate.test.ts` pins
  // the two to the same committed facts so they cannot drift apart.
  const wouldOffer = facts.conformance !== "";
  if (!wouldOffer) {
    notShipped.push(
      "claude-code records no lifecycleConformanceVersion, so local execution " +
        "is offered on no platform. Run the lifecycle conformance suite on " +
        "every advertised platform and record its version in compatibility.ts " +
        "— a green run on one platform is not evidence for the others.",
    );
  }

  if (facts.expectedVersion === "") {
    (wouldOffer ? blockers : notShipped).push(
      "EXPECTED_PACK_VERSION is empty, so no pack has been built and no " +
        "install can ever verify. Run local-harness-pack.yml, then " +
        "scripts/write-pack-digests.mjs, and commit the generated table.",
    );
  }

  const advertisedTargets = [];
  for (const platform of facts.nativePlatforms) {
    const targets = TARGETS_BY_PLATFORM[platform];
    if (targets === undefined) {
      blockers.push(
        `compatibility.ts advertises an unknown platform ${platform}; this ` +
          `check does not know which pack targets it needs.`,
      );
      continue;
    }
    for (const target of targets) {
      const record = facts.records[target];
      if (record === undefined) {
        (wouldOffer ? blockers : notShipped).push(
          `claude-code advertises ${platform} but carries no ${target} pack ` +
            `digest. Either build and publish that target's pack, or drop the ` +
            `platform from nativePlatforms — an advertised target with no pack ` +
            `refuses every install it is offered for.`,
        );
        continue;
      }
      if (record.packVersion !== version) {
        blockers.push(
          `the ${target} digest is stamped ${record.packVersion}, not ` +
            `${version}; its asset URL would not exist in this release.`,
        );
        continue;
      }
      advertisedTargets.push({ target, ...record });
    }
  }

  if (version && (args.assets === true || typeof args["base-url"] === "string")) {
    const baseUrl =
      typeof args["base-url"] === "string"
        ? args["base-url"]
        : `https://github.com/MCPJam/inspector/releases/download/local-harness-pack-v${version}/`;
    const publicKeys = await readPackSigningPublicKeys();
    const { fingerprint } = JSON.parse(await readFile(join(inspectorRoot, "server/utils/harness/local/pack-inputs.generated.json"), "utf8"));
    if (publicKeys.length === 0) {
      blockers.push(
        "pack-signing-key.ts carries no public key, so a published manifest " +
          "cannot be shown to have come from MCPJam.",
      );
    }
    // A published pack is one complete five-target release, even before rollout.
    for (const target of Object.values(TARGETS_BY_PLATFORM).flat()) {
      const entry = facts.records[target];
      if (!entry || entry.packVersion !== version || !/^sha256:[0-9a-f]{64}$/.test(entry.treeDigest)) {
        blockers.push(`Missing or inconsistent pinned pack record for ${target}`);
        continue;
      }
      entry.target = target;
      const names = {
        archive: `local-harness-pack-${entry.target}-${version}.tar.gz`,
        manifest: `local-harness-pack-${entry.target}-${version}.manifest.json`,
        signature: `local-harness-pack-${entry.target}-${version}.manifest.json.sig`,
      };
      let manifestBytes;
      let signature;
      let archive;
      try {
        manifestBytes = await fetchAsset(baseUrl, names.manifest);
        signature = (await fetchAsset(baseUrl, names.signature)).toString(
          "utf8",
        );
        archive = await fetchAsset(baseUrl, names.archive);
      } catch (error) {
        blockers.push(
          `the ${entry.target} pack assets are not published: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
        continue;
      }

      const signed = publicKeys.some((pem) => {
        try {
          return edVerify(
            null,
            manifestBytes,
            createPublicKey(pem),
            Buffer.from(signature.trim(), "base64"),
          );
        } catch {
          return false;
        }
      });
      if (!signed) {
        blockers.push(
          `the published ${entry.target} manifest is not signed by a key this ` +
            `Inspector build carries, so every install of it would be refused.`,
        );
        continue;
      }

      const manifest = JSON.parse(manifestBytes.toString("utf8"));
      if (manifest.inputsFingerprint !== fingerprint) {
        blockers.push(`the published ${entry.target} pack was built from different inputs; publish and pin a new pack version`);
      }
      if (manifest.schema !== "mcpjam.local-harness-pack/1" || manifest.harnessId !== "claude-code" || manifest.platform !== entry.target) {
        blockers.push(`the published ${entry.target} manifest has the wrong identity`);
      }
      if (manifest.treeDigest !== entry.treeDigest) {
        blockers.push(
          `the published ${entry.target} manifest names tree digest ` +
            `${manifest.treeDigest}, but the committed table says ` +
            `${entry.treeDigest}. One of them is not the pack this release ` +
            `reviewed.`,
        );
      }
      const archiveSha = createHash("sha256").update(archive).digest("hex");
      if (manifest.archive?.sha256 !== archiveSha) {
        blockers.push(
          `the published ${entry.target} archive does not match its own signed ` +
            `manifest (manifest ${manifest.archive?.sha256}, asset ` +
            `${archiveSha}).`,
        );
      }
      if (manifest.packVersion !== version) {
        blockers.push(
          `the published ${entry.target} manifest is for pack version ` +
            `${manifest.packVersion}, not ${version}.`,
        );
      }
    }
  }

  if (args["require-ready"] === true) {
    // The release deliberately ships the feature, so "not shipped yet" is a
    // failure rather than a status line.
    blockers.push(...notShipped);
    if (advertisedTargets.length === 0) {
      blockers.push(
        "--require-ready was given, but this build advertises local execution " +
          "on no platform at all.",
      );
    }
  }

  if (blockers.length > 0) {
    console.error(
      `check-local-harness-release: ${blockers.length} blocker(s) — this ` +
        `release advertises local Claude Code execution it cannot serve.\n`,
    );
    for (const blocker of blockers) console.error(`  • ${blocker}\n`);
    process.exit(1);
  }

  for (const note of notShipped) {
    console.log(`check-local-harness-release: not shipped yet — ${note}`);
  }
  if (advertisedTargets.length === 0) {
    console.log(
      "check-local-harness-release: local execution is advertised on no " +
        "platform, which is a consistent (if dark) release.",
    );
    return;
  }
  console.log(
    `check-local-harness-release: ${advertisedTargets.length} target(s) ready ` +
      `at ${version} — ${advertisedTargets.map((e) => e.target).join(", ")}`,
  );
}

// `pathToFileURL` so this compares equal on Windows too, where `process.argv[1]`
// is a drive-letter path and `import.meta.url` is a file: URL.
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  await main();
}

export { readCommittedFacts };
