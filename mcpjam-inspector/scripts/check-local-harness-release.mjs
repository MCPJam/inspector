import { computeHarnessPackInputs, computePackInputs } from "./check-local-harness-inputs.mjs";
import { packAssetStem, packReleaseBaseUrl } from "./local-harness-pack-harnesses.mjs";
import {
  advertisedTargetsOf,
  parseManifestFacts,
  parsePackTables,
  RUNTIME_COMPAT_PATH,
  TARGETS_BY_PLATFORM,
} from "./local-harness-pack-tables.mjs";
import {
  attestationVerifyArgs,
  EQUIVALENCE_SIGNER_WORKFLOW,
  PACK_SIGNER_WORKFLOW,
  readEquivalenceRecords,
  verifyAttestation,
} from "./local-harness-publication.mjs";
/**
 * The release gate for local harness execution, run for EVERY harness with a
 * compatibility manifest entry.
 *
 * Run before a release publishes, and again after its assets exist. It refuses
 * a release that ADVERTISES a local target it cannot serve, harness by harness:
 *
 *   1. every platform in the harness's `nativePlatforms` has a pack digest for
 *      each of its targets, at that harness's independently pinned pack
 *      version;
 *   2. the harness records lifecycle conformance evidence;
 *   3. (with `--assets`) every pack the build may SELECT — the desired one and
 *      the permitted previous one — is published under its harness's release
 *      tag, its manifest is signed by the key this Inspector build carries,
 *      names this harness and target, and its tree digest and archive hash are
 *      byte-identical to the committed ones; and the DESIRED pack was built
 *      from this harness's reviewed inputs — its signed manifest carries this
 *      checkout's inputs fingerprint, OR a committed equivalence record says a
 *      clean rebuild from these inputs reproduced its tree on that target
 *      (`scripts/local-harness-pack-equivalence/`);
 *   3a. (with `--verify-attestations`) each of those assets has build
 *      provenance from `local-harness-pack.yml` on main, and each equivalence
 *      record relied on has provenance from `local-harness-pack-pipeline.yml`
 *      on main (`gh attestation verify`): a pinned pack is not merely signed
 *      by our key, it was built by our workflow from a reviewed commit;
 *   4. (with `--evidence <dir>`) conformance evidence exists for THIS commit's
 *      Inspector layer digest × each pack it selects × every advertised
 *      target. That replaces the old check that each pack carried the bridge
 *      this checkout builds: the bridge is the Inspector layer now, shipped
 *      with the Inspector, so what a release has to prove is that THIS layer
 *      was run against each pack — not that a pack contains a copy of it;
 *   5. (with `--contract <path>`) the result is written as
 *      `runtime-contract.json`, which the release workflow attests and
 *      attaches to the Inspector release.
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
 *   node scripts/check-local-harness-release.mjs --harness codex --require-ready
 *   node scripts/check-local-harness-release.mjs --version 3.4.0 --assets \
 *     --verify-attestations                      # needs `gh` and GH_TOKEN
 *   node scripts/check-local-harness-release.mjs --version 3.4.0 --assets \
 *     --evidence ./evidence --contract ./runtime-contract.json
 *
 * `--version` is the Inspector release and is informational: each harness's
 * pack version is read from the committed `EXPECTED_PACK_VERSIONS`.
 * `--harness` limits every check to one harness; `--base-url` then serves
 * that harness's assets.
 *
 * Exits non-zero with every blocker listed, not just the first: fixing
 * conformance and then discovering the digest table is also empty is two
 * release cycles for one problem.
 */
import { createHash, createPublicKey, verify as edVerify } from "node:crypto";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const inspectorRoot = join(scriptDir, "..");

/**
 * The pins and the conformance stamp come from the generated JSON record
 * (`runtime-compat.generated.json`); the reviewed POLICY (native platforms and
 * targets) is parsed out of `compatibility.ts`. Both are read as COMMITTED,
 * not as a build step could have rewritten them on the way past.
 *
 * Returns one entry per harness that has a manifest entry or a record entry:
 * `{ [harnessId]: { expectedVersion, records, permitted, conformance,
 * nativePlatforms, nativeTargets? } }`.
 */
async function readCommittedFacts() {
  const compatRecord = await readFile(RUNTIME_COMPAT_PATH, "utf8");
  const compatSource = await readFile(
    join(inspectorRoot, "server/utils/harness/local/compatibility.ts"),
    "utf8",
  );
  const tables = parsePackTables(compatRecord);
  const manifests = parseManifestFacts(compatSource);
  const facts = {};
  for (const harnessId of [...new Set([...Object.keys(manifests), ...Object.keys(tables)])].sort()) {
    facts[harnessId] = {
      expectedVersion: tables[harnessId]?.version ?? "",
      records: tables[harnessId]?.records ?? {},
      permitted: tables[harnessId]?.permitted ?? {},
      conformance: tables[harnessId]?.conformance ?? "",
      nativePlatforms: manifests[harnessId]?.nativePlatforms ?? [],
      ...(manifests[harnessId]?.nativeTargets
        ? { nativeTargets: manifests[harnessId].nativeTargets }
        : {}),
    };
  }
  return facts;
}

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

/**
 * Whether the desired pack may stand for this checkout's inputs on one target:
 * built from them (the signed manifest carries the fingerprint), or proven
 * equivalent — a committed record that a clean rebuild from exactly these
 * inputs reproduced exactly this pinned tree. Returns how, or null.
 */
export function fingerprintAcceptance({ harnessId, target, ref, manifestFingerprint, expectedFingerprint, equivalences }) {
  if (expectedFingerprint === null) return null;
  if (manifestFingerprint === expectedFingerprint) return { kind: "built" };
  const record = equivalences.find(
    (candidate) =>
      candidate.harnessId === harnessId &&
      candidate.fingerprint === expectedFingerprint &&
      candidate.packVersion === ref.packVersion &&
      candidate.digests?.[target] === ref.treeDigest,
  );
  return record === undefined ? null : { kind: "equivalent", record };
}

/**
 * One pinned pack's published assets against what this build pins. Every
 * mismatch is a blocker; nothing here is fetched from anywhere but the pack's
 * own release tag (or `--base-url`).
 */
async function checkPublishedPack({ harnessId, target, role, ref, baseUrl, expectedFingerprint, equivalences = [], attest = null, publicKeys, blockers }) {
  const label = `${harnessId} ${target} ${role} ${ref.packVersion}`;
  const stem = packAssetStem(harnessId, target, ref.packVersion);
  let manifestBytes;
  let signature;
  let archive;
  try {
    manifestBytes = await fetchAsset(baseUrl, `${stem}.manifest.json`);
    signature = (await fetchAsset(baseUrl, `${stem}.manifest.json.sig`)).toString("utf8");
    archive = await fetchAsset(baseUrl, `${stem}.tar.gz`);
  } catch (error) {
    blockers.push(
      `the ${label} pack assets are not published: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return;
  }
  const signed = publicKeys.some((pem) => {
    try {
      return edVerify(null, manifestBytes, createPublicKey(pem), Buffer.from(signature.trim(), "base64"));
    } catch {
      return false;
    }
  });
  if (!signed) {
    blockers.push(
      `the published ${label} manifest is not signed by a key this Inspector ` +
        `build carries, so every install of it would be refused.`,
    );
    return;
  }
  const manifest = JSON.parse(manifestBytes.toString("utf8"));
  let accepted = null;
  if (expectedFingerprint !== undefined) {
    accepted = fingerprintAcceptance({
      harnessId,
      target,
      ref,
      manifestFingerprint: manifest.inputsFingerprint ?? null,
      expectedFingerprint,
      equivalences,
    });
    if (accepted === null) {
      blockers.push(
        `the published ${label} pack was built from different inputs, and no equivalence ` +
          `record says a rebuild from this checkout's reproduced it. Start the release ` +
          `again (prepare-release.yml): it publishes and pins ${harnessId}'s pack in the version PR.`,
      );
    }
  }
  if (manifest.schema !== "mcpjam.local-harness-pack/1" || manifest.harnessId !== harnessId || manifest.platform !== target) {
    blockers.push(`the published ${label} manifest has the wrong identity`);
  }
  if (manifest.treeDigest !== ref.treeDigest) {
    blockers.push(
      `the published ${label} manifest names tree digest ${manifest.treeDigest}, ` +
        `but the committed record says ${ref.treeDigest}. One of them is not ` +
        `the pack this release reviewed.`,
    );
  }
  const archiveSha = createHash("sha256").update(archive).digest("hex");
  if (manifest.archive?.sha256 !== archiveSha) {
    blockers.push(
      `the published ${label} archive does not match its own signed manifest ` +
        `(manifest ${manifest.archive?.sha256}, asset ${archiveSha}).`,
    );
  }
  if (manifest.packVersion !== ref.packVersion) {
    blockers.push(`the published ${label} manifest is for pack version ${manifest.packVersion}.`);
  }
  if (attest !== null) {
    // Provenance, not just a signature: these exact bytes were built by the
    // pack workflow on main. Verified from the bytes this check downloaded.
    const dir = await mkdtemp(join(tmpdir(), "mcpjam-attest-"));
    try {
      for (const [suffix, bytes] of [[".manifest.json", manifestBytes], [".tar.gz", archive]]) {
        const path = join(dir, `${stem}${suffix}`);
        await writeFile(path, bytes);
        const failure = await attest.verify(path, { repo: attest.repo, workflow: PACK_SIGNER_WORKFLOW });
        if (failure !== null) {
          blockers.push(`the published ${label} ${suffix.slice(1)} has no verifiable build provenance from ${PACK_SIGNER_WORKFLOW} on main: ${failure}`);
        }
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
    if (accepted?.kind === "equivalent" && !attest.verifiedRecords.has(accepted.record.file)) {
      const failure = await attest.verify(accepted.record.file, { repo: attest.repo, workflow: EQUIVALENCE_SIGNER_WORKFLOW });
      if (failure !== null) {
        blockers.push(`the ${harnessId} equivalence record ${accepted.record.file} has no verifiable provenance from ${EQUIVALENCE_SIGNER_WORKFLOW} on main: ${failure}`);
      } else {
        attest.verifiedRecords.add(accepted.record.file);
      }
    }
  }
}

/**
 * Conformance evidence for THIS commit's Inspector layer × every pack the
 * build may select × every advertised target, from the records
 * `write-conformance-evidence.mjs` wrote in passing legs. Returns the evidence
 * keyed `harness/target/digest` for the contract.
 */
async function checkEvidence({ facts, dir, layers, commit, blockers, harnessFilter }) {
  const records = [];
  for (const name of (await readdir(dir, { recursive: true })).map(String)) {
    if (!name.endsWith(".json") || !/conformance-evidence-/.test(name)) continue;
    try {
      records.push(JSON.parse(await readFile(join(dir, name), "utf8")));
    } catch {
      blockers.push(`conformance evidence ${name} is not readable JSON`);
    }
  }
  const covered = {};
  for (const [harnessId, harnessFacts] of Object.entries(facts)) {
    if (harnessFilter !== null && harnessFilter !== harnessId) continue;
    if (harnessFacts.conformance === "") continue;
    const layerDigest = layers[harnessId] ?? null;
    for (const target of advertisedTargetsOf(harnessFacts)) {
      const desired = harnessFacts.records[target];
      if (!desired) continue;
      const selectable = [
        { role: "desired", ref: desired },
        ...(harnessFacts.permitted?.[target] ? [{ role: "permitted", ref: harnessFacts.permitted[target] }] : []),
      ];
      for (const { role, ref } of selectable) {
        const match = records.find(
          (record) =>
            record.schema === "mcpjam.local-harness-conformance/1" &&
            record.result === "passed" &&
            record.harnessId === harnessId &&
            record.target === target &&
            record.pack?.treeDigest === ref.treeDigest &&
            (record.layerDigest ?? null) === layerDigest &&
            (commit === null || record.commit === commit),
        );
        if (match === undefined) {
          blockers.push(
            `no conformance evidence for ${harnessId} ${target}: this commit's ` +
              `Inspector layer (${layerDigest ?? "pack-shipped bridge"}) × the ` +
              `${role} ${ref.packVersion} pack (${ref.treeDigest.slice(0, 19)}…). ` +
              `A build may only select a pack its own layer was tested against.`,
          );
          continue;
        }
        covered[`${harnessId}/${target}/${ref.treeDigest}`] = match;
      }
    }
  }
  return covered;
}

async function checkHarness({ harnessId, facts, args, publicKeys, attest, blockers, notShipped }) {
  const version = facts.expectedVersion;
  const advertisedTargets = [];
  // Mirrors `localHarnessReleaseBlockers` in
  // `server/utils/harness/local/release-gate.ts`; `release-gate.test.ts` pins
  // the two to the same committed facts so they cannot drift apart.
  const wouldOffer = facts.conformance !== "";
  if (!wouldOffer) {
    notShipped.push(
      `${harnessId} records no lifecycleConformanceVersion, so local execution ` +
        "is offered on no platform. Run the lifecycle conformance suite on " +
        "every advertised platform and record its version in compatibility.ts " +
        "— a green run on one platform is not evidence for the others.",
    );
  }

  if (version === "") {
    (wouldOffer ? blockers : notShipped).push(
      `EXPECTED_PACK_VERSIONS["${harnessId}"] is empty, so no ${harnessId} ` +
        "pack has been built and no install can ever verify. Run " +
        `local-harness-pack.yml with harness=${harnessId}, then ` +
        `scripts/write-pack-digests.mjs --harness ${harnessId}, and commit the ` +
        "generated table.",
    );
  }

  for (const platform of facts.nativePlatforms) {
    const targets = TARGETS_BY_PLATFORM[platform];
    if (targets === undefined) {
      blockers.push(
        `compatibility.ts advertises an unknown platform ${platform} for ` +
          `${harnessId}; this check does not know which pack targets it needs.`,
      );
      continue;
    }
    // D8: only the targets the manifest certifies are advertised; an
    // uncertified architecture is unavailable, not a blocker.
    for (const target of targets.filter((t) => !facts.nativeTargets || facts.nativeTargets.includes(t))) {
      const record = facts.records[target];
      if (record === undefined) {
        (wouldOffer ? blockers : notShipped).push(
          `${harnessId} advertises ${platform} but carries no ${target} pack ` +
            `digest. Either build and publish that target's pack, or drop the ` +
            `platform from nativePlatforms — an advertised target with no pack ` +
            `refuses every install it is offered for.`,
        );
        continue;
      }
      if (record.packVersion !== version) {
        blockers.push(
          `the ${harnessId} ${target} digest is stamped ${record.packVersion}, ` +
            `not ${version}; its asset URL would not exist in this release.`,
        );
        continue;
      }
      advertisedTargets.push({
        harnessId,
        target,
        ...record,
        ...(facts.permitted?.[target] ? { permitted: facts.permitted[target] } : {}),
      });
    }
  }

  if (version && (args.assets === true || typeof args["base-url"] === "string")) {
    const { fingerprint } = await computeHarnessPackInputs(harnessId).catch(() => ({ fingerprint: null }));
    // A published pack is one complete release of every target it ADVERTISES.
    // A harness certified per target (D8, `nativeTargets`) is checked on
    // exactly those: an uncertified architecture is unavailable, so requiring
    // its assets would block an independently certified one — and leaving one
    // of the advertised targets out would hide its failure. Without
    // `nativeTargets`, every target, as before.
    const releaseTargets = facts.nativeTargets ?? Object.values(TARGETS_BY_PLATFORM).flat();
    for (const target of releaseTargets) {
      const entry = facts.records[target];
      if (!entry || entry.packVersion !== version || !/^sha256:[0-9a-f]{64}$/.test(entry.treeDigest)) {
        blockers.push(`Missing or inconsistent pinned ${harnessId} pack record for ${target}`);
        continue;
      }
      const selectable = [
        { role: "desired", ref: entry },
        ...(facts.permitted?.[target] ? [{ role: "permitted", ref: facts.permitted[target] }] : []),
      ];
      for (const { role, ref } of selectable) {
        if (role === "permitted" && typeof args["base-url"] === "string") {
          // A local artifact directory holds ONE build: the desired pack.
          notShipped.push(`${harnessId} ${target}: the permitted ${ref.packVersion} pack is not checked against --base-url`);
          continue;
        }
        await checkPublishedPack({
          harnessId,
          target,
          role,
          ref,
          baseUrl:
            typeof args["base-url"] === "string"
              ? args["base-url"]
              : packReleaseBaseUrl(harnessId, ref.packVersion),
          // Only the DESIRED pack has to be what this checkout's inputs build:
          // a permitted previous pack is older by definition.
          expectedFingerprint: role === "desired" ? fingerprint : undefined,
          equivalences: readEquivalenceRecords(harnessId),
          attest: typeof args["base-url"] === "string" ? null : attest,
          publicKeys,
          blockers,
        });
      }
    }
  }
  return advertisedTargets;
}

async function main() {
  const computed = await computePackInputs();
  const recordedInputs = JSON.parse(await readFile(join(inspectorRoot, "server/utils/harness/local/pack-inputs.generated.json"), "utf8"));
  if (JSON.stringify(computed) !== JSON.stringify(recordedInputs)) throw new Error("Pack inputs differ from the reviewed fingerprints. Recompute and review before releasing.");
  const args = parseArgs(process.argv.slice(2));
  const facts = await readCommittedFacts();
  const harnessFilter = typeof args.harness === "string" ? args.harness : null;
  // Two lists, and the difference between them is the point.
  //
  // `blockers` fail the release: the build would OFFER a local target it
  // cannot serve. `notShipped` only explains why a harness is still dark —
  // a build with no conformance evidence offers local execution nowhere, so
  // it is unshipped rather than broken, and failing every release until an
  // unrelated feature lands is noise nobody keeps. `--require-ready` is how a
  // release that INTENDS to ship the feature turns the second list into the
  // first (for the harnesses `--harness` names, or all of them).
  const blockers = [];
  const notShipped = [];
  const advertisedTargets = [];
  const publicKeys = await readPackSigningPublicKeys();
  if (publicKeys.length === 0 && (args.assets === true || typeof args["base-url"] === "string")) {
    blockers.push(
      "pack-signing-key.ts carries no public key, so a published manifest " +
        "cannot be shown to have come from MCPJam.",
    );
  }
  let attest = null;
  if (args["verify-attestations"] === true) {
    if (args.assets !== true) {
      blockers.push("--verify-attestations needs --assets: it verifies the published assets' provenance");
    } else {
      attest = {
        repo: process.env.GITHUB_REPOSITORY || "MCPJam/inspector",
        verify: verifyAttestation,
        verifiedRecords: new Set(),
      };
    }
  }
  for (const [harnessId, harnessFacts] of Object.entries(facts)) {
    if (harnessFilter !== null && harnessFilter !== harnessId) continue;
    advertisedTargets.push(
      ...(await checkHarness({ harnessId, facts: harnessFacts, args, publicKeys, attest, blockers, notShipped })),
    );
  }

  let layers = null;
  let evidence = null;
  if (typeof args.evidence === "string" || typeof args.contract === "string") {
    const { computeInspectorLayerDigests } = await import("./inspector-layer-digests.mjs");
    layers = await computeInspectorLayerDigests();
  }
  if (typeof args.evidence === "string") {
    evidence = await checkEvidence({
      facts,
      dir: args.evidence,
      layers,
      commit: typeof args.commit === "string" ? args.commit : (process.env.GITHUB_SHA ?? null),
      blockers,
      harnessFilter,
    });
  } else if (typeof args.contract === "string") {
    blockers.push("--contract needs --evidence: a runtime contract names the conformance runs it rests on");
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
        `release advertises local harness execution it cannot serve.\n`,
    );
    for (const blocker of blockers) console.error(`  • ${blocker}\n`);
    process.exit(1);
  }

  for (const note of notShipped) {
    console.log(`check-local-harness-release: not shipped yet — ${note}`);
  }

  if (typeof args.contract === "string" && evidence !== null) {
    const contract = {
      schema: "mcpjam.local-harness-runtime-contract/1",
      inspectorVersion: typeof args.version === "string" ? args.version : null,
      commit: typeof args.commit === "string" ? args.commit : (process.env.GITHUB_SHA ?? null),
      harnesses: {},
    };
    for (const entry of advertisedTargets) {
      const harness = (contract.harnesses[entry.harnessId] ??= {
        layerDigest: layers?.[entry.harnessId] ?? null,
        conformance: facts[entry.harnessId].conformance,
        targets: {},
      });
      const pack = (ref) => {
        const record = evidence[`${entry.harnessId}/${entry.target}/${ref.treeDigest}`];
        return { packVersion: ref.packVersion, treeDigest: ref.treeDigest, evidence: record?.run ?? null };
      };
      harness.targets[entry.target] = {
        desired: pack(entry),
        ...(entry.permitted ? { permitted: pack(entry.permitted) } : {}),
      };
    }
    await writeFile(args.contract, `${JSON.stringify(contract, null, 2)}\n`);
    console.log(`check-local-harness-release: wrote ${args.contract}`);
  }
  if (advertisedTargets.length === 0) {
    console.log(
      "check-local-harness-release: local execution is advertised on no " +
        "platform, which is a consistent (if dark) release.",
    );
    return;
  }
  console.log(
    `check-local-harness-release: ${advertisedTargets.length} target(s) ready — ` +
      advertisedTargets.map((e) => `${e.harnessId} ${e.target}@${e.packVersion}`).join(", "),
  );
}

// `pathToFileURL` so this compares equal on Windows too, where `process.argv[1]`
// is a drive-letter path and `import.meta.url` is a file: URL.
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  await main();
}

export { readCommittedFacts };
// The provenance rules live with the publication pipeline that produces what
// they verify; re-exported so the gate's callers have one import.
export { attestationVerifyArgs, EQUIVALENCE_SIGNER_WORKFLOW, PACK_SIGNER_WORKFLOW };
