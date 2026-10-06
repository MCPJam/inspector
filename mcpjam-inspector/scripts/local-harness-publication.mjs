// Automated, resumable publication of a local-harness runtime pack.
//
// Driven by `.github/workflows/local-harness-pack-pipeline.yml` (one harness
// per run, never two at once for the same harness). Every step is safe to
// re-run, because every decision is re-derived from what already exists —
// published releases, drafts, the committed pin, committed equivalence
// records — keyed by (harness, inputs fingerprint):
//
//   up-to-date    the pinned pack was built from these inputs, or a verified
//                 equivalence record says a rebuild from them reproduced it.
//                 Nothing to do.
//   adopt         a PUBLISHED release already carries this fingerprint (a
//                 previous run published it and failed later). Pin it; build
//                 nothing, mint nothing.
//   finish-draft  a DRAFT carries this fingerprint (a publish failed between
//                 upload and release). Finish that draft; mint nothing.
//   build         nothing carries it. Build every target; then either the
//                 rebuild reproduces the pinned tree digests (a workflow-only
//                 or tooling-only change: record an EQUIVALENCE attestation,
//                 publish nothing) or publish the next patch version.
//
// A version is never reused and nothing is ever overwritten: the next version
// is past every existing release AND draft for the harness, whatever its
// fingerprint, and a draft is only ever finished when its assets are complete
// and carry this exact fingerprint.
//
//   node scripts/local-harness-publication.mjs plan --harness codex
//   node scripts/local-harness-publication.mjs existing --harness codex --version 1.0.2
//   node scripts/local-harness-publication.mjs finish-draft --harness codex --version 1.0.2
//   node scripts/local-harness-publication.mjs digests --harness codex --version 1.0.2
//   node scripts/local-harness-publication.mjs equivalence --harness codex --digests '{…}' --out <file>
//   node scripts/local-harness-publication.mjs evidence --harness codex --digests '{…}' --dir <dir>
//   node scripts/local-harness-publication.mjs attested --harness codex --version 1.0.1
//   node scripts/local-harness-publication.mjs pr-text --harness codex --kind pin --version 1.0.2 …
//   node scripts/local-harness-publication.mjs report --harness codex   (NEEDS = toJSON(needs))
//
// GitHub access is `GITHUB_TOKEN` (or `GH_TOKEN`) against `GITHUB_REPOSITORY`.
import { execFile } from "node:child_process";
import { createPublicKey, verify as edVerify } from "node:crypto";
import { existsSync, readdirSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { computeHarnessPackInputs } from "./check-local-harness-inputs.mjs";
import { packAssetStem, packReleaseTag } from "./local-harness-pack-harnesses.mjs";
import { PACK_TABLE_TARGETS, readAdvertisedTargets, readRuntimeCompat } from "./local-harness-pack-tables.mjs";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const inspectorRoot = join(scriptDir, "..");

/** Committed equivalence records, one immutable file per (harness, fingerprint). */
export const EQUIVALENCE_DIR = join(scriptDir, "local-harness-pack-equivalence");
export const EQUIVALENCE_SCHEMA = "mcpjam.local-harness-pack-equivalence/1";

const VERSION = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/;

export function compareVersions(a, b) {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i += 1) if (pa[i] !== pb[i]) return pa[i] - pb[i];
  return 0;
}

/** The next patch past every version named — never one already used. */
export function nextPatchVersion(versions) {
  const valid = versions.filter((v) => VERSION.test(v)).sort(compareVersions);
  const top = valid.at(-1);
  if (top === undefined) return "1.0.0";
  const [major, minor, patch] = top.split(".").map(Number);
  return `${major}.${minor}.${patch + 1}`;
}

/** A release tag's pack version for this harness, or null for another's. */
export function versionFromTag(harnessId, tag) {
  const prefix = packReleaseTag(harnessId, "");
  if (!tag.startsWith(prefix)) return null;
  const version = tag.slice(prefix.length);
  return VERSION.test(version) ? version : null;
}

const sameDigests = (a, b) => {
  const keys = Object.keys(a).sort();
  return keys.length > 0 && keys.length === Object.keys(b).length && keys.every((k) => a[k] === b[k]);
};

/**
 * What to do for one harness, from the state that exists.
 *
 * @param {{
 *   fingerprint: string,
 *   pinned: { version: string, digests: Record<string,string>, fingerprint: string | null } | null,
 *   equivalences: Array<{ fingerprint: string, packVersion: string, digests: Record<string,string> }>,
 *   releases: Array<{ tag: string, version: string, draft: boolean, fingerprint: string | null, complete: boolean }>,
 * }} state
 */
export function decidePublication(state) {
  const { fingerprint, pinned, equivalences, releases } = state;
  if (pinned !== null && pinned.fingerprint === fingerprint) {
    return { action: "up-to-date", version: pinned.version, reason: "the pinned pack was built from these inputs" };
  }
  if (
    pinned !== null &&
    equivalences.some(
      (record) =>
        record.fingerprint === fingerprint &&
        record.packVersion === pinned.version &&
        sameDigests(record.digests, pinned.digests),
    )
  ) {
    return {
      action: "up-to-date",
      version: pinned.version,
      reason: "a rebuild from these inputs reproduced the pinned pack (equivalence recorded)",
    };
  }
  const published = releases.find((r) => !r.draft && r.fingerprint === fingerprint);
  if (published) {
    return { action: "adopt", version: published.version, reason: `${published.tag} already carries these inputs` };
  }
  const draft = releases.find((r) => r.draft && r.fingerprint === fingerprint && r.complete);
  if (draft) {
    return { action: "finish-draft", version: draft.version, reason: `draft ${draft.tag} carries these inputs` };
  }
  return {
    action: "build",
    version: nextPatchVersion([...releases.map((r) => r.version), ...(pinned ? [pinned.version] : [])]),
    reason: "no release carries these inputs",
  };
}

/**
 * After a full build: did it reproduce the pinned pack on every target?
 * Equivalent means the inputs changed but the bytes did not, so publishing
 * would only make users download the same tree under a new version.
 */
export function decideAfterBuild({ built, pinned }) {
  if (pinned !== null && sameDigests(built, pinned.digests)) {
    return { action: "equivalent", version: pinned.version };
  }
  return { action: "publish" };
}

// ── Provenance ───────────────────────────────────────────────────────────────

/** The workflows whose provenance a pinned asset and an equivalence record must carry. */
export const PACK_SIGNER_WORKFLOW = ".github/workflows/local-harness-pack.yml";
export const EQUIVALENCE_SIGNER_WORKFLOW = ".github/workflows/local-harness-pack-pipeline.yml";

/**
 * `gh attestation verify` arguments: these bytes were built by `workflow` in
 * `repo`, from main, on a GitHub-hosted runner. For a reusable workflow the
 * signer is the CALLED workflow, so a pack built through the pipeline still
 * verifies against `local-harness-pack.yml`.
 */
export function attestationVerifyArgs(path, { repo, workflow }) {
  return [
    "attestation",
    "verify",
    path,
    "--repo",
    repo,
    "--signer-workflow",
    `${repo}/${workflow}`,
    "--source-ref",
    "refs/heads/main",
    "--deny-self-hosted-runners",
  ];
}

const execFileAsync = promisify(execFile);

/** Runs `gh attestation verify`; resolves to null when verified, else why not. */
export async function verifyAttestation(path, options) {
  try {
    await execFileAsync("gh", attestationVerifyArgs(path, options), { maxBuffer: 16 * 1024 * 1024 });
    return null;
  } catch (error) {
    const stderr = typeof error?.stderr === "string" ? error.stderr.trim().split("\n").slice(-2).join(" ") : "";
    return stderr || (error instanceof Error ? error.message : String(error));
  }
}

// ── Conformance evidence ─────────────────────────────────────────────────────

/**
 * The advertised targets a pack has NO passed conformance evidence for, from
 * the records this run's conformance legs wrote. A pin needs none missing:
 * this commit's layer ran on that exact tree, on every target users get it on.
 */
export function missingEvidence({ harnessId, targets, digests, records, commit }) {
  return targets.filter(
    (target) =>
      !records.some(
        (record) =>
          record?.schema === "mcpjam.local-harness-conformance/1" &&
          record.result === "passed" &&
          record.harnessId === harnessId &&
          record.target === target &&
          record.pack?.treeDigest === digests[target] &&
          (commit === null || record.commit === commit),
      ),
  );
}

// ── Pipeline outcome and its paper trail ─────────────────────────────────────

/**
 * The stages of `local-harness-pack-pipeline.yml`, in order, and what each one
 * failing means. Every resume is the same command, because every run
 * re-derives its plan from what exists: a published release is adopted, a
 * complete draft is finished, a pin PR is force-updated, never duplicated.
 */
export const PIPELINE_STAGES = [
  { job: "plan", stage: "plan", meaning: "could not decide what to publish (fingerprint or release listing failed)" },
  { job: "pack", stage: "build-and-publish", meaning: "building, signing, attesting or publishing the pack failed; nothing half-published is ever overwritten, and a complete draft is finished by the next run" },
  { job: "equivalence", stage: "equivalence", meaning: "recording the equivalence attestation or its PR failed" },
  { job: "candidate-conformance", stage: "conformance", meaning: "this commit's Inspector layer failed conformance on the new pack; the pack is published but NOT pinned, and no Inspector selects it" },
  { job: "pin", stage: "pin", meaning: "writing or opening the pin PR failed; the pack is published but not pinned" },
];

/**
 * What a pipeline run amounted to, from `toJSON(needs)`: `failed` at the first
 * stage that failed, `cancelled` (superseded by a newer run — not a failure),
 * or `succeeded`. The PREVIOUS pack's conformance is deliberately not a stage:
 * its failure only means the previous pack is not kept selectable.
 */
export function pipelineOutcome(needs) {
  for (const { job, stage, meaning } of PIPELINE_STAGES) {
    if (needs?.[job]?.result === "failure") return { status: "failed", stage, meaning };
  }
  if (PIPELINE_STAGES.some(({ job }) => needs?.[job]?.result === "cancelled")) return { status: "cancelled" };
  return { status: "succeeded" };
}

export const failureIssueTitle = (harnessId) => `Local harness pack pipeline failing: ${harnessId}`;

/** The command that resumes a harness's pipeline from wherever it stopped. */
export const resumeCommand = (harnessId) => `gh workflow run local-harness-pack-auto.yml --ref main -f harness=${harnessId}`;

/** The failure issue's body (or the comment added to an open one). */
export function failureIssueBody({ harnessId, stage, meaning, runUrl, commit }) {
  return [
    `The **${stage}** stage of the ${harnessId} runtime pack pipeline failed${commit ? ` at ${commit.slice(0, 12)}` : ""}.`,
    "",
    `- What it means: ${meaning}.`,
    `- Run: ${runUrl}`,
    `- Resume (safe to repeat; it adopts or finishes whatever already exists): \`${resumeCommand(harnessId)}\``,
    "",
    "Users are unaffected until a pin PR merges: shipped Inspectors keep selecting the pinned pack.",
  ].join("\n");
}

/**
 * The bot PR's title and body. One branch per harness
 * (`bot/local-harness-pack-<harness>`), force-pushed and edited, never a
 * second PR: a newer run's pin replaces an older one.
 */
export function pinPullRequest(input) {
  const { harnessId, kind, version, previous, permitPrevious, permitReason, fingerprint, runUrl, commit } = input;
  const branch = `bot/local-harness-pack-${harnessId}`;
  if (kind === "equivalence") {
    return {
      branch,
      title: `chore(local-harness): record ${harnessId} pack equivalence (inputs ${fingerprint.slice(7, 19)})`,
      body: [
        `A clean rebuild of the **${harnessId}** pack from \`${commit?.slice(0, 12) ?? "main"}\` reproduced the pinned ${previous} pack byte for byte on every target, so nothing was published.`,
        "",
        `This records that (an attested equivalence record) and moves ${harnessId}'s reviewed inputs fingerprint to \`${fingerprint}\`, which is what the release gate checks.`,
        "",
        `- Pipeline run: ${runUrl}`,
        "- Merging changes no bytes any user downloads.",
      ].join("\n"),
    };
  }
  return {
    branch,
    title: `chore(local-harness): pin ${harnessId} pack ${version}`,
    body: [
      `Pins the **${harnessId}** runtime pack **${version}** (built from inputs \`${fingerprint}\` at \`${commit?.slice(0, 12) ?? "main"}\`).`,
      "",
      `- Built, signed and attested by \`local-harness-pack.yml\`; this commit's Inspector layer passed conformance on it on every advertised target.`,
      previous
        ? permitPrevious
          ? `- **${previous}** stays selectable as the one permitted previous pack: the layer passed conformance on it too, and its provenance verifies.`
          : `- **${previous}** is NOT kept as a permitted previous pack: ${permitReason}.`
        : "- There was no previous pack.",
      `- Pipeline run: ${runUrl}`,
      "",
      "Merging is what makes Inspectors select this pack. A build that cannot verify it keeps using the one it has.",
    ].join("\n"),
  };
}

// ── GitHub IO ────────────────────────────────────────────────────────────────

function github() {
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  const repo = process.env.GITHUB_REPOSITORY || "MCPJam/inspector";
  if (!token) throw new Error("GITHUB_TOKEN (or GH_TOKEN) is required");
  const api = async (path, init = {}) => {
    const response = await fetch(`https://api.github.com/repos/${repo}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${token}`,
        "X-GitHub-Api-Version": "2022-11-28",
        Accept: "application/vnd.github+json",
        ...(init.headers ?? {}),
      },
    });
    if (!response.ok) throw new Error(`GitHub ${init.method ?? "GET"} ${path}: ${response.status}`);
    return response;
  };
  return { repo, api };
}

/** Every release (drafts included) of one harness's packs. */
async function listReleases(harnessId, { api }) {
  const out = [];
  for (let page = 1; page < 50; page += 1) {
    const batch = await (await api(`/releases?per_page=100&page=${page}`)).json();
    for (const release of batch) {
      const version = versionFromTag(harnessId, release.tag_name);
      if (version !== null) out.push({ ...release, version });
    }
    if (batch.length < 100) break;
  }
  return out;
}

async function assetBytes(asset, { api }) {
  const response = await api(`/releases/assets/${asset.id}`, { headers: { Accept: "application/octet-stream" } });
  return Buffer.from(await response.arrayBuffer());
}

/** The PEM keys the shipped Inspector verifies manifests with. */
export function packSigningPublicKeys() {
  const source = readFileSync(join(inspectorRoot, "server/utils/harness/local/pack-signing-key.ts"), "utf8");
  return [...source.matchAll(/-----BEGIN PUBLIC KEY-----[\s\S]*?-----END PUBLIC KEY-----/g)].map((m) => m[0]);
}

const signedByUs = (bytes, signature, keys) =>
  keys.some((pem) => {
    try {
      return edVerify(null, bytes, createPublicKey(pem), Buffer.from(signature.trim(), "base64"));
    } catch {
      return false;
    }
  });

/**
 * A release's identity: its fingerprint (from a signed manifest), whether
 * every target's archive, manifest and signature are attached, and each
 * target's tree digest. A manifest that is not signed by our key does not
 * count: that release carries no fingerprint as far as adoption goes.
 */
async function describeRelease(harnessId, release, gh) {
  const keys = packSigningPublicKeys();
  const names = new Map(release.assets.map((asset) => [asset.name, asset]));
  let fingerprint = null;
  let complete = true;
  const digests = {};
  for (const target of PACK_TABLE_TARGETS) {
    const stem = packAssetStem(harnessId, target, release.version);
    const manifest = names.get(`${stem}.manifest.json`);
    const signature = names.get(`${stem}.manifest.json.sig`);
    const archive = names.get(`${stem}.tar.gz`);
    if (!manifest || !signature || !archive) {
      complete = false;
      continue;
    }
    const bytes = await assetBytes(manifest, gh);
    const sig = (await assetBytes(signature, gh)).toString("utf8");
    if (!signedByUs(bytes, sig, keys)) {
      complete = false;
      continue;
    }
    const parsed = JSON.parse(bytes.toString("utf8"));
    if (parsed.harnessId !== harnessId || parsed.platform !== target || parsed.packVersion !== release.version) {
      complete = false;
      continue;
    }
    if (fingerprint !== null && parsed.inputsFingerprint !== fingerprint) {
      // Targets built from different inputs under one tag: not adoptable.
      return { tag: release.tag_name, version: release.version, draft: release.draft, fingerprint: null, complete: false, digests };
    }
    fingerprint = parsed.inputsFingerprint ?? null;
    digests[target] = parsed.treeDigest;
  }
  return { tag: release.tag_name, version: release.version, draft: release.draft, fingerprint, complete, digests, id: release.id };
}

/** Committed equivalence records for a harness. */
export function readEquivalenceRecords(harnessId, dir = EQUIVALENCE_DIR) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.startsWith(`${harnessId}-`) && name.endsWith(".json"))
    .map((name) => ({ file: join(dir, name), ...JSON.parse(readFileSync(join(dir, name), "utf8")) }))
    .filter((record) => record.schema === EQUIVALENCE_SCHEMA && record.harnessId === harnessId);
}

/** The equivalence record's file name: one per (harness, fingerprint). */
export function equivalenceFileName(harnessId, fingerprint) {
  return `${harnessId}-${fingerprint.replace(/^sha256:/, "").slice(0, 16)}.json`;
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith("--")) continue;
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) args[token.slice(2)] = true;
    else {
      args[token.slice(2)] = next;
      i += 1;
    }
  }
  return args;
}

function output(values) {
  for (const [key, value] of Object.entries(values)) {
    process.stdout.write(`${key}=${typeof value === "string" ? value : JSON.stringify(value)}\n`);
  }
}

async function planCommand(harnessId) {
  const gh = github();
  const { fingerprint } = await computeHarnessPackInputs(harnessId);
  const record = readRuntimeCompat().harnesses[harnessId];
  if (record === undefined) throw new Error(`no ${harnessId} entry in the runtime compatibility record`);
  const desired = Object.fromEntries(
    Object.entries(record.targets).map(([target, slot]) => [target, slot.desired]),
  );
  const pinnedVersion = Object.values(desired)[0]?.packVersion ?? null;
  const releases = await listReleases(harnessId, gh);
  const described = [];
  for (const release of releases) described.push(await describeRelease(harnessId, release, gh));
  const pinnedRelease = described.find((r) => r.version === pinnedVersion && !r.draft) ?? null;
  const pinned =
    pinnedVersion === null
      ? null
      : {
          version: pinnedVersion,
          digests: Object.fromEntries(Object.entries(desired).map(([t, ref]) => [t, ref.treeDigest])),
          fingerprint: pinnedRelease?.fingerprint ?? null,
        };
  const decision = decidePublication({
    fingerprint,
    pinned,
    equivalences: readEquivalenceRecords(harnessId),
    releases: described,
  });
  output({
    action: decision.action,
    version: decision.version,
    reason: decision.reason,
    fingerprint,
    tag: packReleaseTag(harnessId, decision.version),
    pinned_version: pinnedVersion ?? "",
    pinned_digests: JSON.stringify(pinned?.digests ?? {}),
  });
}

async function finishDraftCommand(harnessId, version) {
  const gh = github();
  const { fingerprint } = await computeHarnessPackInputs(harnessId);
  const release = (await listReleases(harnessId, gh)).find((r) => r.version === version);
  if (!release) throw new Error(`no ${harnessId} ${version} release or draft exists`);
  const described = await describeRelease(harnessId, release, gh);
  if (!release.draft) {
    if (described.fingerprint !== fingerprint) throw new Error(`${release.tag_name} is published from different inputs`);
    process.stdout.write(`${release.tag_name} is already published\n`);
    return;
  }
  if (!described.complete || described.fingerprint !== fingerprint) {
    throw new Error(
      `draft ${release.tag_name} is incomplete or from different inputs; it is left untouched ` +
        `and the next run publishes a new version`,
    );
  }
  await gh.api(`/releases/${release.id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ draft: false, make_latest: "false" }),
  });
  process.stdout.write(`published draft ${release.tag_name}\n`);
}

async function digestsCommand(harnessId, version) {
  const gh = github();
  const release = (await listReleases(harnessId, gh)).find((r) => r.version === version && !r.draft);
  if (!release) throw new Error(`no published ${harnessId} ${version} release`);
  const described = await describeRelease(harnessId, release, gh);
  if (!described.complete) throw new Error(`${release.tag_name} is missing signed assets`);
  output({ digests: JSON.stringify(described.digests), fingerprint: described.fingerprint ?? "" });
}

/**
 * What already exists at ONE version, for the pack workflow's preflight:
 *   none          nothing — build and publish it;
 *   published     published from these inputs — adopt it, build nothing;
 *   draft         a complete draft from these inputs — finish it;
 *   conflict      something from OTHER inputs, or an incomplete draft —
 *                 never overwritten; a new version is the only way on.
 */
export function classifyExisting({ fingerprint, release }) {
  if (release === null) return "none";
  if (release.fingerprint !== fingerprint) return "conflict";
  if (!release.draft) return "published";
  return release.complete ? "draft" : "conflict";
}

async function existingCommand(harnessId, version) {
  const gh = github();
  const { fingerprint } = await computeHarnessPackInputs(harnessId);
  const release = (await listReleases(harnessId, gh)).find((r) => r.version === version) ?? null;
  const described = release === null ? null : await describeRelease(harnessId, release, gh);
  output({ state: classifyExisting({ fingerprint, release: described }), fingerprint });
}

function equivalenceCommand(harnessId, args) {
  const digests = JSON.parse(String(args.digests));
  const record = {
    schema: EQUIVALENCE_SCHEMA,
    harnessId,
    // The inputs a clean rebuild was made from…
    fingerprint: String(args.fingerprint),
    // …and the pinned pack it reproduced, byte for byte, on every target.
    packVersion: String(args.version),
    digests: Object.fromEntries(Object.entries(digests).sort(([a], [b]) => (a < b ? -1 : 1))),
    commit: process.env.GITHUB_SHA ?? null,
    run:
      process.env.GITHUB_SERVER_URL && process.env.GITHUB_REPOSITORY && process.env.GITHUB_RUN_ID
        ? `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`
        : null,
  };
  if (!/^sha256:[0-9a-f]{64}$/.test(record.fingerprint)) throw new Error("--fingerprint must be a sha256 fingerprint");
  mkdirSync(dirname(String(args.out)), { recursive: true });
  writeFileSync(String(args.out), `${JSON.stringify(record, null, 2)}\n`);
  process.stdout.write(`equivalence record: ${args.out}\n`);
}

/** Every record under `dir`, wherever the artifact download put it. */
async function readEvidenceDir(dir) {
  if (!existsSync(dir)) return [];
  const records = [];
  for (const name of (await readdir(dir, { recursive: true })).map(String)) {
    if (!name.endsWith(".json") || !name.includes("conformance-evidence-")) continue;
    records.push(JSON.parse(await readFile(join(dir, name), "utf8")));
  }
  return records;
}

async function evidenceCommand(harnessId, args) {
  const digests = JSON.parse(String(args.digests));
  const missing = missingEvidence({
    harnessId,
    targets: readAdvertisedTargets(harnessId),
    digests,
    records: await readEvidenceDir(String(args.dir)),
    commit: process.env.GITHUB_SHA ?? null,
  });
  output({ covered: String(missing.length === 0), missing: missing.join(",") });
}

/** Whether every target's signed manifest of a published version has build provenance. */
async function attestedCommand(harnessId, version) {
  const gh = github();
  const release = (await listReleases(harnessId, gh)).find((r) => r.version === version && !r.draft);
  if (!release) return output({ attested: "false", reason: `no published ${harnessId} ${version} release` });
  const dir = await mkdtemp(join(tmpdir(), "mcpjam-attested-"));
  try {
    for (const target of PACK_TABLE_TARGETS) {
      const name = `${packAssetStem(harnessId, target, version)}.manifest.json`;
      const asset = release.assets.find((candidate) => candidate.name === name);
      if (!asset) return output({ attested: "false", reason: `${name} is not attached` });
      const path = join(dir, name);
      await writeFile(path, await assetBytes(asset, gh));
      const failure = await verifyAttestation(path, { repo: gh.repo, workflow: PACK_SIGNER_WORKFLOW });
      if (failure !== null) {
        return output({ attested: "false", reason: `${name} has no build provenance from ${PACK_SIGNER_WORKFLOW} on main` });
      }
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
  output({ attested: "true", reason: "" });
}

function prTextCommand(harnessId, args) {
  const text = pinPullRequest({
    harnessId,
    kind: args.kind === "equivalence" ? "equivalence" : "pin",
    version: typeof args.version === "string" ? args.version : "",
    previous: typeof args.previous === "string" && args.previous !== "" ? args.previous : null,
    permitPrevious: args["permit-previous"] === "true",
    permitReason: typeof args["permit-reason"] === "string" ? args["permit-reason"] : "",
    fingerprint: String(args.fingerprint ?? ""),
    runUrl: String(args.run ?? ""),
    commit: process.env.GITHUB_SHA ?? null,
  });
  process.stdout.write(`${JSON.stringify(text)}\n`);
}

/**
 * Open (or comment on) the harness's failure issue when the run failed; close
 * it when a run gets through. Never a second issue for the same harness.
 */
async function reportCommand(harnessId) {
  const outcome = pipelineOutcome(JSON.parse(process.env.NEEDS ?? "{}"));
  const runUrl = `${process.env.GITHUB_SERVER_URL ?? "https://github.com"}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`;
  process.stdout.write(`pipeline ${outcome.status}${outcome.stage ? ` at ${outcome.stage}` : ""}\n`);
  if (outcome.status === "cancelled") return;
  const gh = github();
  const title = failureIssueTitle(harnessId);
  // Opened with this workflow's token, so its author is github-actions[bot].
  const open = [];
  for (let page = 1; page <= 10; page += 1) {
    const batch = await (await gh.api(`/issues?state=open&creator=${encodeURIComponent("github-actions[bot]")}&per_page=100&page=${page}`)).json();
    open.push(...batch.filter((issue) => issue.title === title && issue.pull_request === undefined));
    if (batch.length < 100) break;
  }
  const json = { "Content-Type": "application/json" };
  if (outcome.status === "failed") {
    const body = failureIssueBody({ harnessId, ...outcome, runUrl, commit: process.env.GITHUB_SHA ?? null });
    if (open.length > 0) {
      await gh.api(`/issues/${open[0].number}/comments`, { method: "POST", headers: json, body: JSON.stringify({ body }) });
    } else {
      await gh.api(`/issues`, { method: "POST", headers: json, body: JSON.stringify({ title, body }) });
    }
    return;
  }
  for (const issue of open) {
    await gh.api(`/issues/${issue.number}/comments`, {
      method: "POST",
      headers: json,
      body: JSON.stringify({ body: `Resolved: ${runUrl} got through every stage.` }),
    });
    await gh.api(`/issues/${issue.number}`, {
      method: "PATCH",
      headers: json,
      body: JSON.stringify({ state: "closed", state_reason: "completed" }),
    });
  }
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  const args = parseArgs(rest);
  const harnessId = String(args.harness ?? "");
  if (!/^[a-z][a-z0-9-]{0,63}$/.test(harnessId)) throw new Error("--harness is required");
  const version = typeof args.version === "string" ? args.version : "";
  if (version !== "" && !VERSION.test(version)) throw new Error("--version must be a pack semver");
  switch (command) {
    case "plan":
      return planCommand(harnessId);
    case "existing":
      return existingCommand(harnessId, version);
    case "finish-draft":
      return finishDraftCommand(harnessId, version);
    case "digests":
      return digestsCommand(harnessId, version);
    case "equivalence":
      return equivalenceCommand(harnessId, args);
    case "evidence":
      return evidenceCommand(harnessId, args);
    case "attested":
      return attestedCommand(harnessId, version);
    case "pr-text":
      return prTextCommand(harnessId, args);
    case "report":
      return reportCommand(harnessId);
    default:
      throw new Error(`unknown command ${command}`);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  await main();
}
