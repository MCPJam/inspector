/**
 * The Muse policy corpus this product grades against, pinned.
 *
 * WHY A MANIFEST AT ALL. Meta's connector guidelines are documentation, and
 * this documentation is young: the platform opened to submissions in
 * September 2026, and the page itself marks part of the flow "coming soon". A
 * grade that cannot say which revision it was made against does not become
 * obviously wrong when the page changes — it becomes quietly wrong. Every
 * finding therefore carries a {@link MusePolicySourceRef} naming the page, the
 * numbered section, and the snapshot it was graded against.
 *
 * ONLY THE PUBLIC PAGES. The submission form behind `muse.ai/platform` sits
 * behind a login, and third-party write-ups of it mention requirements (an
 * icon size, "OAuth with PKCE") that the public guidelines never state. A
 * requirement nobody can re-read is not one this product can cite, so none of
 * those are graded here.
 *
 * ON `revision`. `npm run muse-policy:sync` fetches each page and rewrites the
 * GENERATED block below with a hash of its visible text; `npm run
 * muse-policy:check` re-fetches and fails on drift. A changed hash against an
 * unchanged `snapshotDate` is the signal that the checks citing that page need
 * re-auditing before any grade made against them is trusted.
 *
 * Pure data. Safe from the browser entry.
 */

/** The date the check inventory was written against this corpus. ISO date. */
export const MUSE_POLICY_SNAPSHOT_DATE = "2026-10-07";

/** Base for every page below; one constant so a moved root is one edit. */
export const MUSE_PLATFORM_BASE_URL = "https://muse.ai/platform";

/**
 * The pages, by stable key. The key — not the URL — is what findings cite, so
 * a URL that moves does not invalidate every finding that referenced it.
 *
 *   - `docs` — the connector guidelines. Every requirement graded here.
 *   - `terms` — the Connector Platform Terms the guidelines incorporate (§4.1).
 *     Pinned so a terms change is visible as drift, though no check reads it
 *     directly: its obligations are contractual, not observable.
 */
export const MUSE_POLICY_PAGES = ["docs", "terms"] as const;

export type MusePolicyPage = (typeof MUSE_POLICY_PAGES)[number];

export interface MusePolicySourceEntry {
  page: MusePolicyPage;
  url: string;
  /**
   * Content hash of the page text at {@link snapshotDate}, or `null` when the
   * sync script has not run. Never fabricated: a hash is a claim that someone
   * read those exact bytes.
   */
  revision: string | null;
  snapshotDate: string;
}

/**
 * A finding's citation: which page, and where on it.
 *
 * `section` names Meta's own numbering ("§3.2 How tools are classified"):
 * the page numbers its sections, and a number survives a reworded heading
 * better than an anchor does.
 */
export interface MusePolicySourceRef {
  page: MusePolicyPage;
  section: string;
  url: string;
  revision: string | null;
  snapshotDate: string;
}

/**
 * Content hashes of each page's visible text, keyed by page.
 *
 * GENERATED — do not edit by hand; run `npm run muse-policy:sync`. A page
 * absent from this map has never been fetched and reports `revision: null`.
 */
// BEGIN GENERATED — sync via `npm run muse-policy:sync`
const PAGE_REVISIONS: Partial<Record<MusePolicyPage, string>> = {
  docs: "60628e5a1c6199b8635a161b7f5a8aaa",
  terms: "98588b3844410fbd5ff3aca6b0000e23",
};
// END GENERATED

const ENTRIES: MusePolicySourceEntry[] = MUSE_POLICY_PAGES.map((page) => ({
  page,
  url: `${MUSE_PLATFORM_BASE_URL}/${page}`,
  revision: PAGE_REVISIONS[page] ?? null,
  snapshotDate: MUSE_POLICY_SNAPSHOT_DATE,
}));

/** The manifest, keyed by page. Total over {@link MUSE_POLICY_PAGES}. */
export const MUSE_POLICY_MANIFEST: Readonly<
  Record<MusePolicyPage, MusePolicySourceEntry>
> = Object.freeze(
  Object.fromEntries(ENTRIES.map((entry) => [entry.page, entry])) as Record<
    MusePolicyPage,
    MusePolicySourceEntry
  >
);

/**
 * Build a finding's citation.
 *
 * Findings call this rather than composing a ref by hand, so no finding can
 * cite a page the manifest does not track.
 */
export function musePolicySource(
  page: MusePolicyPage,
  section: string
): MusePolicySourceRef {
  const entry = MUSE_POLICY_MANIFEST[page];
  return {
    page: entry.page,
    section,
    url: entry.url,
    revision: entry.revision,
    snapshotDate: entry.snapshotDate,
  };
}

/** Whether every page in this corpus has actually been snapshotted. */
export function isMusePolicyCorpusVerified(): boolean {
  return Object.values(MUSE_POLICY_MANIFEST).every(
    (entry) => entry.revision !== null
  );
}
