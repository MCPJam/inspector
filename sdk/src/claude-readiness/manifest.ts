/**
 * The policy corpus this product grades against, pinned.
 *
 * WHY A MANIFEST AT ALL. Anthropic's directory requirements are documentation,
 * and documentation moves. A readiness grade with no record of WHICH revision
 * it was made against does not become obviously wrong when the policy changes —
 * it becomes quietly wrong, which is worse, because a submitter keeps trusting
 * it. Every finding therefore carries a {@link ClaudePolicySourceRef} naming
 * the page, the section, and the snapshot it was graded against, so a stale
 * grade says so about itself.
 *
 * ON `revision`. No hash ships until the sync script
 * (`npm run claude-policy:sync`) has actually fetched the page, and that is
 * deliberate rather than unfinished: a hash is a claim that someone read those
 * exact bytes, and inventing one would make an unverified corpus look audited.
 * Until then a page read at its URL on the snapshot date is pinned to that
 * date, and any other page carries `null`.
 * The script rewrites the GENERATED block below in place — rather than writing
 * a JSON file this module would then have to read — so the manifest stays pure
 * static data with no loader, no `fs`, and nothing to go stale between two
 * files. `npm run claude-policy:check` re-fetches and fails on drift: a changed
 * hash against an unchanged `snapshotDate` is the signal that the checks citing
 * that page need re-auditing before any grade made against them is trusted.
 *
 * ON THE URLs. Anthropic moved the connector docs off `docs.claude.com`, and
 * two pages live elsewhere on the site. {@link CLAUDE_DOCS_BASE_URL} is
 * a single constant precisely so a base that has since moved is one edit and
 * not fourteen, and the sync script reports any entry that no longer resolves
 * instead of silently hashing a 404 page.
 *
 * Pure data. Safe from the browser entry.
 */

/** The date the cited pages were last read at their URLs. ISO date. */
export const CLAUDE_POLICY_SNAPSHOT_DATE = "2026-11-13";

/** When the check inventory was written; pages not read since keep it. */
const INVENTORY_DATE = "2026-08-19";

/**
 * Base for every documentation page below. Not inlined into the entries so
 * that a moved docs root is a one-line change; the sync script verifies it.
 */
export const CLAUDE_DOCS_BASE_URL =
  "https://claude.com/docs/connectors/building";

/**
 * The pages, by stable key. The key — not the URL — is what findings cite, so
 * a URL that moves does not invalidate every finding id that referenced it.
 */
export const CLAUDE_POLICY_PAGES = [
  "directory",
  "verification",
  "submission",
  "review-criteria",
  "authentication",
  "lazy-authentication",
  "enterprise-managed-auth",
  "troubleshooting",
  "mcp-apps/cross-compatibility",
  "mcp-apps/external-links",
  "mcp-apps/troubleshooting",
  "mcp-apps/design-guidelines",
] as const;

export type ClaudePolicyPage = (typeof CLAUDE_POLICY_PAGES)[number];

/** Pages outside {@link CLAUDE_DOCS_BASE_URL}, with their full URLs. */
const CLAUDE_EXTERNAL_POLICY_PAGES = [
  { page: "directory", url: "https://claude.com/docs/directory/publish" },
  {
    page: "verification",
    url: "https://claude.com/docs/connectors/verification",
  },
] as const;

/** Pages read at their URL on the snapshot date; the rest stay unpinned. */
const READ_ON_SNAPSHOT_DATE: readonly string[] = [
  "directory",
  "verification",
  "submission",
  "review-criteria",
  "authentication",
];

export interface ClaudePolicySourceEntry {
  page: ClaudePolicyPage;
  url: string;
  /**
   * Content hash of the page text at {@link snapshotDate}, or until the sync
   * script has run, the date a page was read. Never fabricated — see the
   * module docblock.
   */
  revision: string | null;
  snapshotDate: string;
}

/**
 * A finding's citation: which page, and where on it.
 *
 * `section` is free text on purpose. Anchors churn faster than prose, and a
 * reader who is handed "the §Authentication → Lazy authentication heading"
 * can find it in a reorganised page; a dead `#anchor` helps nobody.
 */
export interface ClaudePolicySourceRef {
  page: ClaudePolicyPage;
  section: string;
  url: string;
  revision: string | null;
  snapshotDate: string;
}

/**
 * Content hashes of each page's visible text, keyed by page.
 *
 * GENERATED — do not edit by hand; run `npm run claude-policy:sync`. A page
 * absent from this map has never been fetched and reports its read date.
 */
// BEGIN GENERATED — sync via `npm run claude-policy:sync`
const PAGE_REVISIONS: Partial<Record<ClaudePolicyPage, string>> = {};
// END GENERATED

const ENTRIES: ClaudePolicySourceEntry[] = CLAUDE_POLICY_PAGES.map((page) => {
  const external = CLAUDE_EXTERNAL_POLICY_PAGES.find((e) => e.page === page);
  const readOn = READ_ON_SNAPSHOT_DATE.includes(page)
    ? CLAUDE_POLICY_SNAPSHOT_DATE
    : undefined;
  return {
    page,
    url: external?.url ?? `${CLAUDE_DOCS_BASE_URL}/${page}`,
    revision: PAGE_REVISIONS[page] ?? readOn ?? null,
    snapshotDate: readOn ?? INVENTORY_DATE,
  };
});

/** The manifest, keyed by page. Total over {@link CLAUDE_POLICY_PAGES}. */
export const CLAUDE_POLICY_MANIFEST: Readonly<
  Record<ClaudePolicyPage, ClaudePolicySourceEntry>
> = Object.freeze(
  Object.fromEntries(ENTRIES.map((entry) => [entry.page, entry])) as Record<
    ClaudePolicyPage,
    ClaudePolicySourceEntry
  >,
);

/**
 * Build a finding's citation.
 *
 * Findings call this rather than composing a ref by hand, so a page's URL,
 * revision and snapshot date can only ever come from the manifest — the whole
 * point being that no finding can cite a source the manifest does not track.
 */
export function claudePolicySource(
  page: ClaudePolicyPage,
  section: string,
): ClaudePolicySourceRef {
  const entry = CLAUDE_POLICY_MANIFEST[page];
  return {
    page: entry.page,
    section,
    url: entry.url,
    revision: entry.revision,
    snapshotDate: entry.snapshotDate,
  };
}

/**
 * Whether this corpus has actually been snapshotted: a date pin says when a
 * page was read, not what it said, so only the sync script's hashes count.
 *
 * Surfaces show it next to a grade: "graded against an unverified policy
 * snapshot" is a materially weaker claim than one pinned to the pages' text,
 * and collapsing the two would misrepresent the product.
 */
export function isPolicyCorpusVerified(): boolean {
  return CLAUDE_POLICY_PAGES.every((page) => PAGE_REVISIONS[page]);
}
