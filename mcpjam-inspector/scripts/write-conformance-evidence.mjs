// Record one passed conformance leg as machine-checkable evidence: THIS
// checkout's Inspector layer, run against ONE pack, on ONE target.
//
//   node scripts/write-conformance-evidence.mjs --harness codex --target linux-x64 \
//     --runtime "$RUNNER_TEMP/conformance/runtime/codex" --out "$RUNNER_TEMP/evidence" \
//     [--pack-version 1.0.1] [--scenarios attended,attended-off]
//
// Written only by a workflow step that runs AFTER the leg's scenarios passed,
// and uploaded as an artifact. `check-local-harness-release.mjs --evidence`
// then requires a record for every (harness × pack it may select × advertised
// target) at this commit's layer digest, and folds them into the attested
// `runtime-contract.json` a release carries. This replaces the
// `lifecycleConformanceVersion` stamp that used to be typed in by hand.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { tsImport } from "tsx/esm/api";
import { computeInspectorLayerDigests } from "./inspector-layer-digests.mjs";

export const EVIDENCE_SCHEMA = "mcpjam.local-harness-conformance/1";

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

/** The file name a record is written and uploaded under. */
export function evidenceFileName({ harnessId, target, treeDigest }) {
  // The FULL digest: two packs merged into one artifact directory (a
  // candidate and its predecessor) must never share a file name.
  return `conformance-evidence-${harnessId}-${target}-${treeDigest.slice(7)}.json`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const harnessId = String(args.harness ?? "");
  const target = String(args.target ?? "");
  if (!/^[a-z][a-z0-9-]{0,63}$/.test(harnessId)) throw new Error("--harness is required");
  if (!/^(darwin|linux)-(arm64|x64)$|^win32-x64$/.test(target)) throw new Error("--target is required");
  if (typeof args.runtime !== "string" || typeof args.out !== "string") {
    throw new Error("--runtime and --out are required");
  }
  const { computeTreeDigest } = await tsImport("../server/utils/harness/local/tree-digest.ts", {
    parentURL: import.meta.url,
    tsconfig: false,
  });
  const treeDigest = await computeTreeDigest(resolve(args.runtime));
  // A published pack's identity comes from its verified input record when the
  // leg prepared one; a pack built from source has only its digest.
  let published = null;
  if (typeof args.published === "string") {
    published = JSON.parse(await readFile(resolve(args.published), "utf8"));
    if (published.treeDigest !== treeDigest || published.harnessId !== harnessId || published.target !== target) {
      throw new Error("the runtime on disk is not the published pack this leg prepared");
    }
  }
  const layers = await computeInspectorLayerDigests();
  const record = {
    schema: EVIDENCE_SCHEMA,
    harnessId,
    target,
    pack: {
      treeDigest,
      packVersion: published?.version ?? (typeof args["pack-version"] === "string" ? args["pack-version"] : null),
      published: published !== null,
    },
    // `null` for a harness whose bridge still ships in its pack: the launch is
    // then pinned by the pack digest alone.
    layerDigest: layers[harnessId] ?? null,
    commit: process.env.GITHUB_SHA ?? null,
    run:
      process.env.GITHUB_SERVER_URL && process.env.GITHUB_REPOSITORY && process.env.GITHUB_RUN_ID
        ? `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`
        : null,
    scenarios: typeof args.scenarios === "string" ? args.scenarios.split(",").filter(Boolean) : [],
    result: "passed",
    recordedAt: new Date().toISOString(),
  };
  await mkdir(resolve(args.out), { recursive: true });
  const path = join(resolve(args.out), evidenceFileName({ harnessId, target, treeDigest }));
  await writeFile(path, `${JSON.stringify(record, null, 2)}\n`);
  process.stdout.write(`conformance evidence: ${path}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  await main();
}
