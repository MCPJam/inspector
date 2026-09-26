import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { ERROR_CATALOG } from "../../src/error-describer/index.js";

const DOCS_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../docs/troubleshooting/error-codes.mdx"
);

/**
 * Mintlify's heading-slug rule: lowercase, drop everything that is not a word
 * character / space / hyphen, then hyphenate the runs of whitespace.
 */
function slugify(heading: string): string {
  return heading
    .trim()
    .toLowerCase()
    .replace(/[^\w\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-");
}

function docsHeadingSlugs(): Set<string> {
  const source = readFileSync(DOCS_PATH, "utf8");
  const slugs = new Set<string>();
  for (const match of source.matchAll(/^#{2,4} (.+)$/gm)) {
    slugs.add(slugify(match[1] ?? ""));
  }
  return slugs;
}

describe("catalog docsAnchor coverage", () => {
  it("every catalog entry links to a heading that exists in the docs", () => {
    const slugs = docsHeadingSlugs();
    const missing = Object.values(ERROR_CATALOG)
      .filter((entry) => !slugs.has(entry.docsAnchor.split("#")[1] ?? ""))
      .map((entry) => `${entry.slug} -> ${entry.docsAnchor}`);
    expect(missing).toEqual([]);
  });

  it("no heading punctuation makes a slug ambiguous to the renderer", () => {
    // `### Paginated tool / header discovery unsupported` slugified to either
    // `…-tool-header-…` or `…-tool--header-…` depending on whose rule you
    // apply, so the anchor was a coin flip. Headings that anchors point at
    // must not carry punctuation that different slugifiers drop differently.
    const source = readFileSync(DOCS_PATH, "utf8");
    const targeted = new Set(
      Object.values(ERROR_CATALOG).map(
        (entry) => entry.docsAnchor.split("#")[1] ?? ""
      )
    );
    const risky = [...source.matchAll(/^#{2,4} (.+)$/gm)]
      .map((match) => (match[1] ?? "").trim())
      .filter(
        (heading) =>
          targeted.has(slugify(heading)) &&
          /[^\w\s-]\s|\s[^\w\s-]/.test(heading)
      );
    expect(risky).toEqual([]);
  });
});
