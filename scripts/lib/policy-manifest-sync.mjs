/**
 * Shared machinery for pinning a publisher's documentation into a readiness
 * policy manifest.
 *
 * WHY THIS EXISTS. Every readiness finding cites a page, a section, and the
 * revision it was graded against. Without a real revision, a grade cannot tell
 * anyone that the policy moved underneath it — it just stays confidently
 * wrong. Each publisher's manifest therefore ships with `revision: null` on
 * every entry (a fabricated hash would make an unaudited corpus look audited)
 * and a sync script is what fills them in.
 *
 * The RULES of that sync are identical whoever publishes the docs, and every
 * one of them was learned the hard way in the Claude script:
 *
 *   - a page that fails to fetch is loud, never hashed as a 404 body;
 *   - a PARTIAL failure writes nothing, because rewriting the block from the
 *     pages that succeeded would delete the rest's recorded revisions and
 *     silently un-verify half the corpus on the way to exiting non-zero;
 *   - a MISSING recorded revision counts as drift, so `--check` cannot pass an
 *     unsnapshotted corpus off as "no drift" — the one state where a grade's
 *     provenance is least trustworthy;
 *   - "never snapshotted" and "changed since the snapshot" are reported
 *     separately, because sending a maintainer to re-audit a check against a
 *     diff that does not exist wastes the one action this script asks for.
 *
 * What VARIES is the corpus: which pages, on which hosts, fetched as HTML or
 * as Markdown, and whether the publisher offers a machine-readable index that
 * can reveal a page nobody pinned. Those are arguments.
 */

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";

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
 *
 * NOTE: this is only for HTML pages. A publisher that serves a Markdown twin
 * of every page is hashed over the exact `.md` bytes instead — there is no
 * markup to strip, and reducing Markdown to "visible text" would throw away
 * the structure a policy actually lives in.
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

    // `<!doctype html>` is not a tag `readTag` recognises, so without this it
    // would survive as literal text and a markup-only doctype change would
    // move the policy revision.
    if (/^<!doctype(?:\s|>)/i.test(html.slice(lt, lt + 10))) {
      const end = html.indexOf(">", lt + 2);
      out.push(" ");
      index = end === -1 ? html.length : end + 1;
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

/**
 * Pull every `"quoted"` string out of a named `as const` array literal.
 *
 * Whitespace-tolerant around the `=` on purpose. A formatter is free to wrap a
 * long declaration onto the next line, and a regex that assumed a single space
 * would then match nothing — syncing an EMPTY corpus while reporting success,
 * which is the one failure mode this whole file exists to prevent.
 *
 * AN EMPTY EXTRACTION IS A FAILED ONE, and returning `[]` here would walk
 * straight back into that failure by another door: `[]` is truthy, so a caller
 * writing `if (!pages) throw` accepts it, syncs a corpus of nothing, records no
 * drift and exits 0 — a green check that verified zero pages. The only reading
 * of "this array literal parsed but held no strings" that is safe is that the
 * literal is not in the shape this reader understands.
 */
export function readConstArray(source, name) {
  const block = source.match(
    new RegExp(`${name}\\s*=\\s*\\[([\\s\\S]*?)\\] as const;`)
  );
  if (!block) return undefined;
  const values = [...block[1].matchAll(/"([^"]+)"/g)].map((match) => match[1]);
  return values.length > 0 ? values : undefined;
}

/**
 * Pull every `{ page: "…", url: "…" }` pair out of a named array literal.
 *
 * Empty is `undefined` for the same reason as `readConstArray`.
 */
export function readPageUrlPairs(source, name) {
  const block = source.match(
    new RegExp(`${name}\\s*=\\s*\\[([\\s\\S]*?)\\] as const;`)
  );
  if (!block) return undefined;
  const pairs = [
    ...block[1].matchAll(/page:\s*"([^"]+)"\s*,\s*url:\s*"([^"]+)"/g),
  ].map((match) => ({ page: match[1], url: match[2] }));
  return pairs.length > 0 ? pairs : undefined;
}

/**
 * Fetch one page and reduce it to the bytes the revision is taken over.
 *
 * `format: "markdown"` hashes the response body EXACTLY as served. A publisher
 * that ships a `.md` twin of every page has already done the work `extractText`
 * exists to do, and better: there is no navigation chrome, no build hash and
 * no asset URL in it, so the digest moves when the prose moves and at no other
 * time. Running the HTML text-extractor over Markdown would be strictly worse —
 * it would collapse the whitespace that Markdown uses for structure.
 */
async function fetchRevisionBody(url, format) {
  const response = await fetch(url, {
    redirect: "follow",
    headers: {
      accept: format === "markdown" ? "text/markdown, text/plain" : "text/html",
    },
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) {
    // Loudly, not silently: hashing a 404 page would pin the manifest to
    // "page not found" and then report no drift forever after.
    throw new Error(`${response.status} ${response.statusText}`);
  }
  const body = await response.text();
  return {
    text: format === "markdown" ? body : extractText(body),
    // Recorded where served, purely as a human aid when a maintainer is trying
    // to work out WHEN a page moved. Never part of the hash: an origin that
    // rotates ETags on every deploy would otherwise manufacture drift.
    etag: response.headers.get("etag") ?? undefined,
    lastModified: response.headers.get("last-modified") ?? undefined,
  };
}

export function hashPolicyText(text) {
  return createHash("sha256").update(text).digest("hex").slice(0, 32);
}

/** The revisions currently recorded in the manifest's GENERATED block. */
export function readRecordedRevisions(source, begin, end) {
  const beginIndex = source.indexOf(begin);
  // SEARCHED FROM `beginIndex`, not from the top of the file. `// END
  // GENERATED` is a short, quotable string, and the moment one appears in a
  // docblock above the block itself — explaining the markers, say — a search
  // from zero returns that one, and the splice that follows rewrites the
  // wrong span of the manifest.
  const endIndex =
    beginIndex === -1 ? -1 : source.indexOf(end, beginIndex + begin.length);
  if (beginIndex === -1 || endIndex === -1) {
    throw new Error("Could not find the GENERATED block in the manifest.");
  }
  return {
    beginIndex,
    endIndex,
    recorded: Object.fromEntries(
      [
        ...source
          .slice(beginIndex, endIndex)
          .matchAll(/"([^"]+)":\s*"([0-9a-f]+)"/g),
      ].map((match) => [match[1], match[2]])
    ),
  };
}

/**
 * Run one publisher's sync.
 *
 * @param {object} options
 * @param {string} options.manifestPath        Absolute path to the TS manifest.
 * @param {string} options.begin               The GENERATED block's opening marker.
 * @param {string} options.end                 The GENERATED block's closing marker.
 * @param {string} options.revisionsDeclaration  The `const … = ` line the block declares.
 * @param {{page: string, url: string, format?: "html"|"markdown"}[]} options.pages
 * @param {boolean} options.checkOnly          `--check`: report drift, write nothing.
 * @param {string} options.syncCommand         What to tell the reader to run.
 * @param {() => Promise<{label: string, drifted: boolean, message: string}[]>} [options.extraSignals]
 *   Corpus-level drift signals that are not per-page hashes — an upstream index
 *   that lists a page nobody pinned, a changelog that moved. Reported and
 *   counted as drift alongside the page hashes.
 * @returns {Promise<number>} process exit code
 */
export async function syncPolicyManifest(options) {
  const {
    manifestPath,
    begin,
    end,
    revisionsDeclaration,
    pages,
    checkOnly,
    syncCommand,
    extraSignals,
  } = options;

  const results = [];
  let failures = 0;

  for (const entry of pages) {
    try {
      const { text, etag, lastModified } = await fetchRevisionBody(
        entry.url,
        entry.format ?? "html"
      );
      const revision = hashPolicyText(text);
      results.push({ page: entry.page, url: entry.url, revision });
      const served = [etag, lastModified].filter(Boolean).join(" ");
      console.log(
        `ok    ${entry.page}  ${revision}  (${text.length} chars)${
          served ? `  ${served}` : ""
        }`
      );
    } catch (error) {
      failures += 1;
      results.push({ page: entry.page, url: entry.url, revision: null });
      console.error(`FAIL  ${entry.page}  ${entry.url}  ${error}`);
    }
  }

  const source = readFileSync(manifestPath, "utf8");
  const { beginIndex, endIndex, recorded } = readRecordedRevisions(
    source,
    begin,
    end
  );

  // A MISSING recorded revision counts as drift: `--check` must not accept an
  // unsnapshotted corpus as "no drift".
  const drifted = results.filter(
    (entry) => entry.revision && recorded[entry.page] !== entry.revision
  );
  const unsnapshotted = drifted.filter((entry) => !recorded[entry.page]);
  // A page that was never recorded did not CHANGE. Folding both into one
  // "changed since the recorded snapshot" line sends a maintainer to re-audit
  // a check against a diff that does not exist.
  const changed = drifted.filter((entry) => recorded[entry.page]);

  // A page the manifest pins that the corpus no longer lists is drift too, and
  // it is invisible to a per-page hash: every pinned page can be byte-identical
  // while the publisher has added three requirements on a page nobody cited.
  const signals = extraSignals ? await extraSignals() : [];
  for (const signal of signals) {
    console[signal.drifted ? "error" : "log"](
      `${signal.drifted ? "DRIFT" : "ok   "} ${signal.label}  ${signal.message}`
    );
  }
  const signalDrift = signals.filter((signal) => signal.drifted).length;

  if (checkOnly) {
    if (unsnapshotted.length > 0) {
      console.error(
        `\nNOT SNAPSHOTTED: ${unsnapshotted.length} page(s) have no recorded ` +
          `revision. Run \`${syncCommand}\` to pin the corpus before relying ` +
          `on a readiness grade's provenance.`
      );
    }
    if (changed.length > 0) {
      console.error(
        `\nDRIFT: ${changed
          .map((entry) => entry.page)
          .join(
            ", "
          )} changed since the recorded snapshot. Re-audit the checks ` +
          `that cite these pages, then re-run without --check.`
      );
    }
    return drifted.length > 0 || failures > 0 || signalDrift > 0 ? 1 : 0;
  }

  // NOTHING IS WRITTEN AFTER A PARTIAL FAILURE. `entries` excludes the pages
  // that failed, so writing here would DELETE their previously recorded
  // revisions — a transient network blip would silently un-verify part of the
  // corpus on its way to exiting non-zero.
  if (failures > 0) {
    console.error(
      `\n${failures} page(s) could not be fetched; the manifest was left unchanged.`
    );
    return 1;
  }

  const entries = results
    .filter((entry) => entry.revision)
    .map((entry) => `  "${entry.page}": "${entry.revision}",`)
    .join("\n");
  const block = `${begin}\n${revisionsDeclaration}{${
    entries ? `\n${entries}\n` : ""
  }};\n`;
  writeFileSync(
    manifestPath,
    source.slice(0, beginIndex) + block + source.slice(endIndex)
  );
  console.log(`\nwrote ${manifestPath}`);

  // An index signal still fails the run after a successful write: the pinned
  // pages are now current, and the corpus is still missing one.
  return signalDrift > 0 ? 1 : 0;
}
