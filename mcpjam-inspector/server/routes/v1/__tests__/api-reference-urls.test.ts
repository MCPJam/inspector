import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

// Guards the public URLs of the generated API reference on docs.mcpjam.com.
// Mintlify derives each endpoint page's URL from the operation's first tag and
// its summary — /api-reference/{tag}/{summary} — so a vocabulary rename in
// docs/reference/openapi.json (hosts → clients, user-testing → studies, wave →
// swarm run) silently moves the page. Four such renames left 44 URLs returning
// 404 to search engines and to anyone holding a link.
//
// docs/reference/published-api-pages.json is the ledger of every URL the spec
// has ever produced. Every page the spec produces today must be in it, and
// every URL in it that the spec no longer produces must redirect, in
// docs/docs.json, to a page that still exists.

const here = dirname(fileURLToPath(import.meta.url));
const docsDir = resolve(here, "../../../../../docs");

const spec = JSON.parse(
  readFileSync(resolve(docsDir, "reference/openapi.json"), "utf8"),
) as {
  paths: Record<string, Record<string, { tags?: string[]; summary?: string }>>;
};
const docsConfig = JSON.parse(
  readFileSync(resolve(docsDir, "docs.json"), "utf8"),
) as { redirects?: Array<{ source: string; destination: string }> };
const ledger = JSON.parse(
  readFileSync(resolve(docsDir, "reference/published-api-pages.json"), "utf8"),
) as string[];

const HTTP_METHODS = new Set(["get", "post", "put", "patch", "delete"]);

// Mintlify's slug rule, checked against the live sitemap: punctuation is
// dropped rather than turned into a separator ("a host's" → "a-hosts",
// "OTLP/JSON" → "otlpjson"). The last two steps — collapsing runs of hyphens
// and trimming them from the ends — have never run on real input; see the
// `slugify` table below.
function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

const generated: Array<{ url: string; operation: string }> = [];
for (const [path, methods] of Object.entries(spec.paths)) {
  for (const [method, op] of Object.entries(methods)) {
    if (!HTTP_METHODS.has(method)) continue;
    const operation = `${method.toUpperCase()} ${path}`;
    // No fallback on purpose. Every operation has both today, and a guessed
    // tag or summary would write into the ledger a URL Mintlify never emits.
    const tag = op.tags?.[0];
    const summary = op.summary;
    if (!tag || !summary) {
      throw new Error(
        `${operation} has no ${tag ? "summary" : "tag"}, so its page URL cannot be predicted — give it one`,
      );
    }
    generated.push({
      url: `/api-reference/${slugify(tag)}/${slugify(summary)}`,
      operation,
    });
  }
}
const current = new Set(generated.map((g) => g.url));
const redirectList = docsConfig.redirects ?? [];
const redirects = new Map(redirectList.map((r) => [r.source, r.destination]));

/**
 * Whether a redirect destination is a page that resolves: an API page the
 * spec still generates, or a docs page with a file behind it.
 *
 * A file rather than a navigation entry, because Mintlify serves a page that
 * is left out of the navigation too — requiring a nav entry would reject a
 * redirect to a hidden page that works.
 */
function resolves(destination: string): boolean {
  if (destination.startsWith("/api-reference/")) {
    return current.has(destination);
  }
  const page = resolve(docsDir, destination.replace(/^\//, ""));
  return existsSync(`${page}.mdx`) || existsSync(`${page}.md`);
}

describe("API reference URLs", () => {
  it("gives every operation its own page", () => {
    const seen = new Map<string, string>();
    const collisions: string[] = [];
    for (const { url, operation } of generated) {
      const other = seen.get(url);
      if (other) collisions.push(`${url}: ${other} and ${operation}`);
      seen.set(url, operation);
    }
    expect(collisions, "two operations share a tag and summary").toEqual([]);
  });

  it("records every published page in the ledger", () => {
    const known = new Set(ledger);
    const missing = [...current].filter((url) => !known.has(url)).sort();
    expect(
      missing,
      "add these to docs/reference/published-api-pages.json — once published, a URL must keep resolving",
    ).toEqual([]);
  });

  it("redirects every retired URL", () => {
    const unredirected = ledger
      .filter((url) => !current.has(url) && !redirects.has(url))
      .sort();
    expect(
      unredirected,
      "these URLs no longer exist and have no redirect in docs/docs.json",
    ).toEqual([]);
  });

  // The ledger is only useful append-only, and the test above cannot tell: it
  // iterates the ledger, so a deleted row is never examined and its redirect
  // obligation vanishes with a green suite. The likeliest way to lose one is
  // not malice but a merge conflict — every endpoint-adding PR appends to this
  // sorted list. A redirect with no ledger row is the trace a lost row leaves.
  it("keeps a ledger entry for every API URL docs.json redirects away", () => {
    const known = new Set(ledger);
    const orphans = [...redirects.keys()]
      .filter((source) => source.startsWith("/api-reference/"))
      .filter((source) => !known.has(source))
      .sort();
    expect(
      orphans,
      "a redirect with no ledger entry means the ledger lost a row",
    ).toEqual([]);
  });

  // Every redirect, not only the retired API URLs: the non-API ones
  // (/inspector/views → /inspector/playground and the six before it) would
  // otherwise be the only redirects nothing checks.
  it("sends every redirect to a page that resolves", () => {
    const dangling = redirectList
      .filter((r) => !resolves(r.destination))
      .map((r) => `${r.source} → ${r.destination}`)
      .sort();
    expect(dangling, "these redirect to a page that does not exist").toEqual(
      [],
    );
  });

  // `redirects` is a Map, so a repeated source would silently keep the last
  // destination — and which one Mintlify honours is not ours to guess.
  it("lists each redirect source once", () => {
    const seen = new Set<string>();
    const repeated = redirectList
      .map((r) => r.source)
      .filter((source) => (seen.has(source) ? true : (seen.add(source), false)));
    expect(repeated).toEqual([]);
  });
});

describe("slugify", () => {
  // Real summaries from the spec, and the URL segments the live sitemap has
  // for them. These are the only punctuation cases the spec has ever used, in
  // any of its revisions: ' ( ) , / and -.
  it.each([
    ["List a harness's native built-in tools", "list-a-harnesss-native-built-in-tools"],
    [
      "Create a client (from a template or a full config)",
      "create-a-client-from-a-template-or-a-full-config",
    ],
    [
      "Enable, repoint, or disable a suite's schedule",
      "enable-repoint-or-disable-a-suites-schedule",
    ],
    ["Export project traces as OTLP/JSON", "export-project-traces-as-otlpjson"],
    ["Get the host-compat catalog", "get-the-host-compat-catalog"],
  ])("%j → %s", (summary, slug) => {
    expect(slugify(summary)).toBe(slug);
  });

  // Deliberately not pinned: what Mintlify emits for &, _, an em dash or a
  // double space. No summary has ever contained one, so the hyphen-collapsing
  // and trimming steps above are unverified — and github-slugger, the usual
  // source of this rule, does NOT collapse runs ("Foo & Bar" → "foo--bar").
  // The first summary to use one should be checked against the live sitemap
  // before this function is trusted with it.
});
