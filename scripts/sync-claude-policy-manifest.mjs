#!/usr/bin/env node
/**
 * Snapshot Anthropic's connector-directory documentation into the readiness
 * policy manifest.
 *
 * WHY THIS EXISTS. Every Claude readiness finding cites a page, a section, and
 * the revision it was graded against. Without a real revision, a grade cannot
 * tell anyone that the policy moved underneath it — it just stays confidently
 * wrong. `sdk/src/claude-readiness/manifest.ts` therefore ships with
 * `revision: null` on every entry (a fabricated hash would make an unaudited
 * corpus look audited) and this script is what fills them in.
 *
 * WHAT IT DOES. Fetches every page in the manifest, reduces the HTML to its
 * visible text so a rebuilt bundle hash or a rotated asset URL does not read as
 * a policy change, hashes that, and rewrites the GENERATED block in
 * `manifest.ts` in place — so the manifest stays static data the browser entry
 * can import, with no JSON loader and no second file to drift against.
 *
 * Usage:
 *   node scripts/sync-claude-policy-manifest.mjs            # write revisions
 *   node scripts/sync-claude-policy-manifest.mjs --check    # exit 1 on drift
 *
 * `--check` is the one that matters in CI: a changed hash against an unchanged
 * `snapshotDate` means the docs moved and the check inventory needs
 * re-auditing before any grade made against it can be trusted.
 */

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const MANIFEST = resolve(ROOT, "sdk/src/claude-readiness/manifest.ts");
const BEGIN = "// BEGIN GENERATED — sync via `npm run claude-policy:sync`";
const END = "// END GENERATED";

const checkOnly = process.argv.includes("--check");

/** Read the page list and base URL out of the TS module without importing it. */
function readManifestSource() {
  const source = readFileSync(MANIFEST, "utf8");
  const baseMatch = source.match(/CLAUDE_DOCS_BASE_URL = "([^"]+)"/);
  const pagesBlock = source.match(
    /CLAUDE_POLICY_PAGES = \[([\s\S]*?)\] as const;/,
  );
  if (!baseMatch || !pagesBlock) {
    throw new Error(
      "Could not read CLAUDE_DOCS_BASE_URL / CLAUDE_POLICY_PAGES from the manifest.",
    );
  }
  const pages = [...pagesBlock[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  return { baseUrl: baseMatch[1], pages };
}

/**
 * Visible text only, by scanning rather than by pattern-matching.
 *
 * Hashing raw HTML would make every unrelated site rebuild look like a policy
 * change, and a manifest that cries wolf is a manifest nobody re-runs. So the
 * markup has to come out — and the obvious `replace(/<[^>]+>/g, " ")` is wrong
 * in three ways that all corrupt the hash: it ends a tag at a `>` inside a
 * quoted attribute value, it does not match `</script >` with a space (so the
 * script body leaks into the text), and it turns comment bodies into content.
 * Each of those makes the digest depend on markup trivia, which is exactly
 * what this function exists to remove.
 *
 * A scanner has none of those problems, and it is short.
 */
export function extractText(html) {
  const out = [];
  let index = 0;

  while (index < html.length) {
    const lt = html.indexOf("<", index);
    if (lt === -1) {
      out.push(html.slice(index));
      break;
    }
    out.push(html.slice(index, lt));

    if (html.startsWith("<!--", lt)) {
      const end = html.indexOf("-->", lt + 4);
      out.push(" ");
      index = end === -1 ? html.length : end + 3;
      continue;
    }

    const tag = readTag(html, lt);
    if (!tag) {
      // A `<` that does not begin a tag — "a < b" — is content, not markup.
      out.push("<");
      index = lt + 1;
      continue;
    }

    out.push(" ");
    index =
      !tag.closing && !tag.selfClosing && RAW_TEXT_ELEMENTS.has(tag.name)
        ? skipRawText(html, tag.end, tag.name)
        : tag.end;
  }

  return out
    .join("")
    .replace(/&nbsp;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Elements whose content is not markup and must be dropped whole. */
const RAW_TEXT_ELEMENTS = new Set(["script", "style"]);

/**
 * Read one tag starting at `start` (which must point at `<`).
 *
 * Returns `undefined` when what follows is not a tag name, so `a < b` stays
 * text. Quoted attribute values are skipped, so `<a title="a>b">` ends where
 * the tag actually ends.
 */
function readTag(html, start) {
  let index = start + 1;
  const closing = html[index] === "/";
  if (closing) index += 1;

  const nameStart = index;
  while (index < html.length && /[A-Za-z0-9:-]/.test(html[index])) index += 1;
  if (index === nameStart) return undefined;
  const name = html.slice(nameStart, index).toLowerCase();

  let quote;
  while (index < html.length) {
    const char = html[index];
    if (quote) {
      if (char === quote) quote = undefined;
    } else if (char === '"' || char === "'") {
      quote = char;
    } else if (char === ">") {
      return {
        name,
        closing,
        selfClosing: html[index - 1] === "/",
        end: index + 1,
      };
    }
    index += 1;
  }
  // Unterminated tag: everything after it is markup we cannot parse, so drop it.
  return { name, closing, selfClosing: false, end: html.length };
}

/**
 * Skip to just past `</name …>`, tolerating whitespace and attributes in the
 * end tag. `</script >` is valid HTML and a naive `"</script>"` search walks
 * straight past it, taking the entire rest of the document as script body.
 */
function skipRawText(html, from, name) {
  const lower = html.toLowerCase();
  const needle = `</${name}`;
  let index = from;
  for (;;) {
    const at = lower.indexOf(needle, index);
    if (at === -1) return html.length;
    const after = html[at + needle.length];
    // A name boundary: `</script>`, `</script >`, `</script\n>` — but not
    // `</scriptfoo>`, which is a different element.
    if (after === undefined || after === ">" || /\s/.test(after)) {
      const tag = readTag(html, at);
      return tag ? tag.end : html.length;
    }
    index = at + needle.length;
  }
}

async function fetchPage(url) {
  const response = await fetch(url, {
    redirect: "follow",
    headers: { accept: "text/html" },
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) {
    // Loudly, not silently: hashing a 404 page would pin the manifest to
    // "page not found" and then report no drift forever after.
    throw new Error(`${response.status} ${response.statusText}`);
  }
  return extractText(await response.text());
}

/**
 * The side-effecting half, behind a direct-invocation guard so a test can
 * import {@link extractText} without the module fetching twelve pages as an
 * import side effect.
 */
async function main() {
  const { baseUrl, pages } = readManifestSource();
  const results = [];
  let failures = 0;

  for (const page of pages) {
    const url = `${baseUrl}/${page}`;
    try {
      const text = await fetchPage(url);
      const revision = createHash("sha256").update(text).digest("hex").slice(0, 32);
      results.push({ page, url, revision, bytes: text.length });
      console.log(`ok    ${page}  ${revision}  (${text.length} chars)`);
    } catch (error) {
      failures += 1;
      results.push({ page, url, revision: null, error: String(error) });
      console.error(`FAIL  ${page}  ${url}  ${error}`);
    }
  }

  const source = readFileSync(MANIFEST, "utf8");
  const beginIndex = source.indexOf(BEGIN);
  const endIndex = source.indexOf(END);
  if (beginIndex === -1 || endIndex === -1) {
    throw new Error("Could not find the GENERATED block in the manifest.");
  }
  const previous = Object.fromEntries(
    [
      ...source
        .slice(beginIndex, endIndex)
        .matchAll(/"([^"]+)":\s*"([0-9a-f]+)"/g),
    ].map((match) => [match[1], match[2]]),
  );

  const drifted = results.filter(
    (entry) =>
      entry.revision &&
      previous[entry.page] &&
      previous[entry.page] !== entry.revision,
  );

  if (checkOnly) {
    if (drifted.length > 0) {
      console.error(
        `\nDRIFT: ${drifted
          .map((entry) => entry.page)
          .join(", ")} changed since the recorded snapshot. Re-audit the checks ` +
          `that cite these pages, then re-run without --check.`,
      );
    }
    process.exit(drifted.length > 0 || failures > 0 ? 1 : 0);
  }

  const entries = results
    .filter((entry) => entry.revision)
    .map((entry) => `  "${entry.page}": "${entry.revision}",`)
    .join("\n");
  const block = `${BEGIN}\nconst PAGE_REVISIONS: Partial<Record<ClaudePolicyPage, string>> = {${
    entries ? `\n${entries}\n` : ""
  }};\n`;
  writeFileSync(
    MANIFEST,
    source.slice(0, beginIndex) + block + source.slice(endIndex),
  );
  console.log(`\nwrote ${MANIFEST}`);
  if (failures > 0) {
    console.error(
      `${failures} page(s) could not be fetched; their revisions stay null.`,
    );
    process.exit(1);
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  await main();
}
