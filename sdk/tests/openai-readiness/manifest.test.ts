/**
 * The policy corpus and its provenance rules.
 *
 * The corpus is the thing every finding cites, so the invariants here are the
 * ones that keep a citation meaningful: no fabricated hash, no page a finding
 * can name that the manifest does not track, and an honest answer to "was this
 * corpus ever snapshotted at all".
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  OPENAI_EXTERNAL_POLICY_PAGES,
  OPENAI_PLUGINS_DOCS_BASE_URL,
  OPENAI_PLUGINS_POLICY_PAGES,
  OPENAI_POLICY_MANIFEST,
  OPENAI_POLICY_PAGES,
  OPENAI_POLICY_SNAPSHOT_DATE,
  isOpenAIPolicyCorpusVerified,
  openaiPolicySource,
} from "../../src/openai-readiness/manifest.js";

const here = dirname(fileURLToPath(import.meta.url));
const MANIFEST_SOURCE = join(here, "../../src/openai-readiness/manifest.ts");

describe("the corpus", () => {
  it("tracks every page exactly once", () => {
    expect(new Set(OPENAI_POLICY_PAGES).size).toBe(OPENAI_POLICY_PAGES.length);
    expect(Object.keys(OPENAI_POLICY_MANIFEST)).toHaveLength(
      OPENAI_POLICY_PAGES.length,
    );
  });

  it("pins the pages a finding is allowed to cite, and only those", () => {
    for (const page of OPENAI_POLICY_PAGES) {
      expect(OPENAI_POLICY_MANIFEST[page].page).toBe(page);
    }
  });

  it("hashes the plugins corpus over its markdown twin", () => {
    // The `.md` twin has no navigation chrome and no build hash in it, so the
    // digest moves when the prose moves and at no other time. Hashing the
    // rendered HTML would make every site rebuild look like a policy change.
    for (const page of OPENAI_PLUGINS_POLICY_PAGES) {
      const entry = OPENAI_POLICY_MANIFEST[page];
      expect(entry.format).toBe("markdown");
      expect(entry.url).toBe(`${OPENAI_PLUGINS_DOCS_BASE_URL}/${page}`);
      expect(entry.revisionUrl).toBe(`${entry.url}.md`);
    }
  });

  it("falls back to html for pages on hosts with no markdown twin", () => {
    expect(OPENAI_EXTERNAL_POLICY_PAGES.length).toBeGreaterThan(0);
    for (const { page, url } of OPENAI_EXTERNAL_POLICY_PAGES) {
      const entry = OPENAI_POLICY_MANIFEST[page];
      expect(entry.format).toBe("html");
      // A second host is the reason entries carry full URLs rather than slugs
      // under one base — a single base would have silently excluded these.
      expect(entry.url).toBe(url);
      expect(entry.url.startsWith(OPENAI_PLUGINS_DOCS_BASE_URL)).toBe(false);
    }
  });

  it("stamps one snapshot date across the whole corpus", () => {
    for (const page of OPENAI_POLICY_PAGES) {
      expect(OPENAI_POLICY_MANIFEST[page].snapshotDate).toBe(
        OPENAI_POLICY_SNAPSHOT_DATE,
      );
    }
  });
});

describe("revisions are never fabricated", () => {
  it("ships an empty GENERATED block until the sync script runs", () => {
    // A hash is a claim that someone read those exact bytes. Hand-writing one
    // would make an unverified corpus look audited, which is the single most
    // misleading thing this module could do.
    const source = readFileSync(MANIFEST_SOURCE, "utf8");
    // ASSERTED, not assumed. If either marker were renamed, `indexOf` returns
    // -1, `slice(-1, -1)` returns "", the hash sweep below finds nothing and
    // this test passes — reporting "no fabricated hashes" about a block it
    // never read. The markers are the test's whole premise, so they are the
    // first thing checked.
    const begin = source.indexOf("// BEGIN GENERATED");
    const end = source.indexOf("// END GENERATED", begin);
    expect(begin).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(begin);
    const generated = source.slice(begin, end);
    const handWritten = [...generated.matchAll(/"([0-9a-f]{32})"/g)];
    for (const [, hash] of handWritten) {
      // Any hash present must have come from a sync run, which also fills
      // every other page. A partially-filled block means someone typed one.
      expect(hash).toMatch(/^[0-9a-f]{32}$/);
    }
    expect(
      handWritten.length === 0 ||
        handWritten.length === OPENAI_POLICY_PAGES.length,
    ).toBe(true);
  });

  it("reports the corpus as unverified while any revision is null", () => {
    const anyNull = Object.values(OPENAI_POLICY_MANIFEST).some(
      (entry) => entry.revision === null,
    );
    expect(isOpenAIPolicyCorpusVerified()).toBe(!anyNull);
  });
});

describe("openaiPolicySource", () => {
  it("carries the manifest's url, revision and snapshot onto the citation", () => {
    const ref = openaiPolicySource("deploy/submission", "§Scan tools");
    const entry = OPENAI_POLICY_MANIFEST["deploy/submission"];
    expect(ref).toEqual({
      page: "deploy/submission",
      section: "§Scan tools",
      url: entry.url,
      revision: entry.revision,
      snapshotDate: entry.snapshotDate,
    });
  });

  it("propagates a null revision rather than hiding it", () => {
    // A finding graded against an unpinned page must SAY so; a citation that
    // silently dropped the null would read as pinned.
    const ref = openaiPolicySource("app-guidelines", "§Overview");
    expect(ref.revision).toBe(
      OPENAI_POLICY_MANIFEST["app-guidelines"].revision,
    );
  });
});
