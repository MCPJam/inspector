// The Inspector layer digest THIS checkout compiles in, per harness — the
// exact value a build verifies its on-disk layer against, and the identity
// conformance evidence and the release contract are keyed by.
//
//   node scripts/inspector-layer-digests.mjs      # prints {"codex":"sha256:…","claude-code":…}
//
// Regenerates the layer bundle first (a stale gitignored bundle would report
// a digest this checkout does not build), then asks the server module that
// defines the layer's contents, so the two can never disagree.
import { pathToFileURL } from "node:url";
import { tsImport } from "tsx/esm/api";
import { bundleLocalHarnessLayer } from "./bundle-local-harness-layer.mjs";

/** `{ [harnessId]: digest | null }`; `null` = the harness's bridge ships in its pack. */
export async function computeInspectorLayerDigests() {
  await bundleLocalHarnessLayer();
  const { inspectorLayerDigest } = await tsImport(
    "../server/utils/harness/local/inspector-layer-files.ts",
    { parentURL: import.meta.url, tsconfig: false },
  );
  const { SUPPORTED_LOCAL_HARNESS_IDS } = await tsImport(
    "../server/utils/harness/local/targets.ts",
    { parentURL: import.meta.url, tsconfig: false },
  );
  return Object.fromEntries(
    [...SUPPORTED_LOCAL_HARNESS_IDS].sort().map((id) => [id, inspectorLayerDigest(id)]),
  );
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  process.stdout.write(`${JSON.stringify(await computeInspectorLayerDigests())}\n`);
}
