#!/usr/bin/env node
/**
 * Snapshot Anthropic's connector-directory documentation into the readiness
 * policy manifest.
 *
 * The RULES of the sync — hash the visible text so a rebuilt bundle is not
 * drift, fail loudly on a 404 rather than pinning it, write nothing after a
 * partial failure, count a missing revision as drift — live in
 * `lib/policy-manifest-sync.mjs`, shared with the OpenAI corpus. This file is
 * the Anthropic-specific half: where the manifest is, which pages it pins, and
 * that they are fetched as HTML.
 *
 * Usage:
 *   node scripts/sync-claude-policy-manifest.mjs            # write revisions
 *   node scripts/sync-claude-policy-manifest.mjs --check    # exit 1 on drift
 *
 * `--check` is the one that matters in CI: a changed hash against an unchanged
 * `snapshotDate` means the docs moved and the check inventory needs
 * re-auditing before any grade made against it can be trusted.
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  readConstArray,
  syncPolicyManifest,
} from "./lib/policy-manifest-sync.mjs";

/**
 * Re-exported because the extractor decides what the drift hash is over, and
 * `sdk/tests/claude-readiness/policy-text.test.ts` pins its behaviour against
 * the markup cases a regex filter gets wrong. Importing it from here keeps that
 * test pointed at the script it is about.
 */
export { extractText } from "./lib/policy-manifest-sync.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const MANIFEST = resolve(ROOT, "sdk/src/claude-readiness/manifest.ts");
const BEGIN = "// BEGIN GENERATED — sync via `npm run claude-policy:sync`";
const END = "// END GENERATED";

/** Read the page list and base URL out of the TS module without importing it. */
function readManifestSource() {
  const source = readFileSync(MANIFEST, "utf8");
  const baseMatch = source.match(/CLAUDE_DOCS_BASE_URL\s*=\s*"([^"]+)"/);
  const pages = readConstArray(source, "CLAUDE_POLICY_PAGES");
  if (!baseMatch || !pages) {
    throw new Error(
      "Could not read CLAUDE_DOCS_BASE_URL / CLAUDE_POLICY_PAGES from the manifest.",
    );
  }
  return { baseUrl: baseMatch[1], pages };
}

async function main() {
  const { baseUrl, pages } = readManifestSource();
  const code = await syncPolicyManifest({
    manifestPath: MANIFEST,
    begin: BEGIN,
    end: END,
    revisionsDeclaration:
      "const PAGE_REVISIONS: Partial<Record<ClaudePolicyPage, string>> = ",
    // Anthropic's docs are served as HTML with no Markdown twin, so the text
    // extractor is what makes the hash stable under an unrelated site rebuild.
    pages: pages.map((page) => ({
      page,
      url: `${baseUrl}/${page}`,
      format: "html",
    })),
    checkOnly: process.argv.includes("--check"),
    syncCommand: "npm run claude-policy:sync",
  });
  process.exit(code);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
