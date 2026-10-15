#!/usr/bin/env node
/**
 * Pin (or check) the Muse policy corpus that `sdk/src/muse-readiness` grades
 * against.
 *
 *   npm run muse-policy:sync    fetch each page, rewrite the GENERATED block
 *   npm run muse-policy:check   fetch each page, fail on drift, write nothing
 *
 * Meta's guidelines are served as HTML with no Markdown twin and no index, so
 * this is the simplest of the three publishers: one hash per page over its
 * visible text, via the shared extractor. The page numbers its sections, and
 * every Muse finding cites one — a moved hash means re-reading the sections
 * the checks cite before re-pinning.
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  readConstArray,
  syncPolicyManifest,
} from "./lib/policy-manifest-sync.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const MANIFEST = resolve(ROOT, "sdk/src/muse-readiness/manifest.ts");
const BEGIN = "// BEGIN GENERATED — sync via `npm run muse-policy:sync`";
const END = "// END GENERATED";

/** Read the corpus out of the TS module without importing it. */
export function readManifestSource(source) {
  const baseMatch = source.match(/MUSE_PLATFORM_BASE_URL\s*=\s*"([^"]+)"/);
  const pages = readConstArray(source, "MUSE_POLICY_PAGES");
  if (!baseMatch || !pages) {
    throw new Error(
      "Could not read MUSE_PLATFORM_BASE_URL / MUSE_POLICY_PAGES from the manifest."
    );
  }
  return { baseUrl: baseMatch[1], pages };
}

async function main() {
  const { baseUrl, pages } = readManifestSource(readFileSync(MANIFEST, "utf8"));
  const code = await syncPolicyManifest({
    manifestPath: MANIFEST,
    begin: BEGIN,
    end: END,
    revisionsDeclaration:
      "const PAGE_REVISIONS: Partial<Record<MusePolicyPage, string>> = ",
    pages: pages.map((page) => ({
      page,
      url: `${baseUrl}/${page}`,
      format: "html",
    })),
    checkOnly: process.argv.includes("--check"),
    syncCommand: "npm run muse-policy:sync",
  });
  process.exit(code);
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  await main();
}
