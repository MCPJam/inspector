#!/usr/bin/env node
/**
 * Snapshot OpenAI's plugin-directory documentation into the readiness policy
 * manifest.
 *
 * The RULES of the sync live in `lib/policy-manifest-sync.mjs`, shared with the
 * Anthropic corpus. What is OpenAI-specific is all here, and it is three
 * things:
 *
 *   1. MARKDOWN, NOT HTML. Every page under the plugins base is served with a
 *      `.md` twin, so the revision is a hash of those exact bytes. There is no
 *      navigation chrome, no build hash and no asset URL in them, so the digest
 *      moves when the prose moves and at no other time — strictly better than
 *      extracting visible text from a rendered page. The two help-centre
 *      articles have no twin and fall back to HTML text extraction.
 *
 *   2. THE INDEX DIFF. `llms.txt` is the publisher's own list of the page set.
 *      Diffing it against the manifest catches the failure a per-page hash
 *      cannot see: every pinned page byte-identical while a requirement landed
 *      on a page nobody pinned. A page ADDED upstream and a page REMOVED
 *      upstream are both drift — the first means the corpus is incomplete, the
 *      second means a finding is citing something that no longer exists.
 *
 *   3. THE CHANGELOG. A coarse second signal, hashed like any other page, that
 *      fires when a change is announced before the reference pages catch up.
 *
 * Usage:
 *   node scripts/sync-openai-policy-manifest.mjs            # write revisions
 *   node scripts/sync-openai-policy-manifest.mjs --check    # exit 1 on drift
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  readConstArray,
  readPageUrlPairs,
  syncPolicyManifest,
} from "./lib/policy-manifest-sync.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const MANIFEST = resolve(ROOT, "sdk/src/openai-readiness/manifest.ts");
const BEGIN = "// BEGIN GENERATED — sync via `npm run openai-policy:sync`";
const END = "// END GENERATED";

/** Read the corpus out of the TS module without importing it. */
export function readManifestSource(source) {
  const baseMatch = source.match(/OPENAI_PLUGINS_DOCS_BASE_URL\s*=\s*"([^"]+)"/);
  const plugins = readConstArray(source, "OPENAI_PLUGINS_POLICY_PAGES");
  const external = readPageUrlPairs(source, "OPENAI_EXTERNAL_POLICY_PAGES");
  if (!baseMatch || !plugins || !external) {
    throw new Error(
      "Could not read OPENAI_PLUGINS_DOCS_BASE_URL / OPENAI_PLUGINS_POLICY_PAGES / " +
        "OPENAI_EXTERNAL_POLICY_PAGES from the manifest."
    );
  }
  return { baseUrl: baseMatch[1], plugins, external };
}

/**
 * Every documentation slug `llms.txt` lists, relative to the plugins base.
 *
 * `llms.txt` is a Markdown link list, so the slugs are read out of the link
 * targets rather than the prose around them. Absolute URLs on OTHER hosts are
 * ignored on purpose: the index links out to the Apps SDK and the commerce
 * specs, and pulling those into this corpus would pin pages that belong to a
 * different product's policy.
 */
export function parseLlmsIndex(body, baseUrl) {
  const slugs = new Set();
  for (const match of body.matchAll(/\]\(([^)\s]+)/g)) {
    let target = match[1];
    if (target.startsWith(baseUrl)) {
      target = target.slice(baseUrl.length);
    } else if (/^https?:\/\//.test(target)) {
      continue;
    }
    // `/plugins/build/skills.md` and `build/skills` are the same page.
    const slug = target
      .replace(/^\/?plugins\/?/, "")
      .replace(/\.md$/, "")
      .replace(/^\/+/, "")
      .replace(/\/+$/, "")
      .replace(/#.*$/, "");
    if (slug) slugs.add(slug);
  }
  return slugs;
}

/**
 * Compare the live index against the pinned page set.
 *
 * Reported as a corpus-level signal rather than a per-page failure because
 * that is what it is: nothing we pinned changed, and the corpus is still wrong.
 */
export function diffIndexAgainstCorpus(indexSlugs, pinnedSlugs) {
  const pinned = new Set(pinnedSlugs);
  const added = [...indexSlugs].filter((slug) => !pinned.has(slug)).sort();
  const removed = [...pinned].filter((slug) => !indexSlugs.has(slug)).sort();
  if (added.length === 0 && removed.length === 0) {
    return {
      drifted: false,
      message: `llms.txt lists ${indexSlugs.size} page(s); the corpus pins the same set.`,
    };
  }
  const parts = [];
  if (added.length > 0) {
    parts.push(
      `${
        added.length
      } page(s) upstream that the corpus does not pin: ${added.join(", ")}`
    );
  }
  if (removed.length > 0) {
    parts.push(
      `${
        removed.length
      } pinned page(s) no longer listed upstream: ${removed.join(", ")}`
    );
  }
  return { drifted: true, message: parts.join("; ") };
}

async function checkIndex(baseUrl, pinnedSlugs) {
  const url = `${baseUrl}/llms.txt`;
  try {
    const response = await fetch(url, {
      redirect: "follow",
      headers: { accept: "text/plain" },
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) {
      throw new Error(`${response.status} ${response.statusText}`);
    }
    return {
      label: "llms.txt",
      ...diffIndexAgainstCorpus(
        parseLlmsIndex(await response.text(), baseUrl),
        pinnedSlugs
      ),
    };
  } catch (error) {
    // An unreachable index is drift, not a pass: the whole point of the check
    // is that we cannot otherwise tell whether the corpus is complete.
    return {
      label: "llms.txt",
      drifted: true,
      message: `could not read ${url}: ${error}`,
    };
  }
}

async function main() {
  const source = readFileSync(MANIFEST, "utf8");
  const { baseUrl, plugins, external } = readManifestSource(source);

  const code = await syncPolicyManifest({
    manifestPath: MANIFEST,
    begin: BEGIN,
    end: END,
    revisionsDeclaration:
      "const PAGE_REVISIONS: Partial<Record<OpenAIPolicyPage, string>> = ",
    pages: [
      ...plugins.map((page) => ({
        page,
        url: `${baseUrl}/${page}.md`,
        format: "markdown",
      })),
      ...external.map((entry) => ({
        page: entry.page,
        url: entry.url,
        format: "html",
      })),
    ],
    checkOnly: process.argv.includes("--check"),
    syncCommand: "npm run openai-policy:sync",
    extraSignals: async () => [await checkIndex(baseUrl, plugins)],
  });
  process.exit(code);
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  await main();
}
