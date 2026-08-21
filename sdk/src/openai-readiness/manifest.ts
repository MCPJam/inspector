/**
 * The OpenAI plugin-directory policy corpus this product grades against,
 * pinned.
 *
 * WHY A MANIFEST AT ALL. OpenAI's plugin-directory requirements are
 * documentation, and documentation moves. A readiness grade with no record of
 * WHICH revision it was made against does not become obviously wrong when the
 * policy changes — it becomes quietly wrong, which is worse, because a
 * submitter keeps trusting it. Every finding therefore carries an
 * {@link OpenAIPolicySourceRef} naming the page, the section, and the snapshot
 * it was graded against, so a stale grade says so about itself.
 *
 * WHAT THIS PRODUCT IS. A LOCAL PREFLIGHT that implements OpenAI's documented
 * rules. It is emphatically not a reproduction of the submission portal's
 * validator, and nothing here should be read as predicting a portal verdict:
 * the portal is authoritative, the submission-errors page is an error CATALOG
 * rather than the validator's source, and a preflight that claimed otherwise
 * would be making a promise it cannot keep.
 *
 * ON `revision`. Every entry ships `null` until the sync script
 * (`npm run openai-policy:sync`) has actually fetched the page, and that is
 * deliberate rather than unfinished: a hash is a claim that someone read those
 * exact bytes, and inventing one would make an unverified corpus look audited.
 * The script rewrites the GENERATED block below in place — rather than writing
 * a JSON file this module would then have to read — so the manifest stays pure
 * static data with no loader, no `fs`, and nothing to go stale between two
 * files. `npm run openai-policy:check` re-fetches and fails on drift.
 *
 * ON MARKDOWN. Unlike Anthropic's docs, every page under
 * {@link OPENAI_PLUGINS_DOCS_BASE_URL} is served with a `.md` twin, and
 * `llms.txt` is a machine-readable index of the whole set. The sync therefore
 * hashes the exact Markdown bytes — no HTML text extraction, so no dependence
 * on navigation chrome or a build hash — and separately diffs the live index
 * against {@link OPENAI_PLUGINS_POLICY_PAGES}. That second check catches the
 * failure a per-page hash cannot see: every pinned page byte-identical while
 * the publisher added a requirement on a page nobody cited.
 *
 * ON THE SECOND HOST. A few normative pages are help-centre articles with no
 * Markdown twin, so entries carry FULL URLs rather than a slug under one base.
 * A single base constant would have quietly excluded them from the corpus.
 *
 * Pure data. Safe from the browser entry.
 */

/** The date the check inventory was written against this corpus. ISO date. */
export const OPENAI_POLICY_SNAPSHOT_DATE = "2026-08-19";

/**
 * Base for the plugins documentation. Not inlined into the entries so that a
 * moved docs root is a one-line change; the sync script verifies it.
 */
export const OPENAI_PLUGINS_DOCS_BASE_URL =
  "https://developers.openai.com/plugins";

/**
 * The publisher's own index of the page set.
 *
 * Authoritative for "which pages exist", which is why the sync diffs it rather
 * than trusting {@link OPENAI_PLUGINS_POLICY_PAGES} to stay complete on its
 * own. A page added upstream is a policy change even when nothing we pinned
 * moved.
 */
export const OPENAI_PLUGINS_LLMS_INDEX_URL = `${OPENAI_PLUGINS_DOCS_BASE_URL}/llms.txt`;

/**
 * The changelog, checked as a coarse SECOND drift signal.
 *
 * Cheap, and it fires in a case the per-page hashes miss entirely: a change
 * announced in the changelog before the reference pages catch up. It is not a
 * substitute for the page hashes and is never cited by a finding.
 */
export const OPENAI_PLUGINS_CHANGELOG_URL = `${OPENAI_PLUGINS_DOCS_BASE_URL}/changelog`;

/**
 * Pages under {@link OPENAI_PLUGINS_DOCS_BASE_URL}, by slug. The slug — not the
 * URL — is what findings cite, so a URL that moves does not invalidate every
 * finding id that referenced it.
 *
 * The whole documented page set is pinned rather than only the pages a check
 * happens to cite today. Hashing is cheap, the set is small, and the
 * alternative — pin what we cite — means a requirement can appear on an
 * unpinned page and drift past every signal this module has.
 */
export const OPENAI_PLUGINS_POLICY_PAGES = [
  "quickstart",
  "app-guidelines",
  "reference",
  "changelog",
  "plan/use-case",
  "plan/tools",
  "concepts/plugins",
  "concepts/skills",
  "concepts/ui-guidelines",
  "build/plugins",
  "build/skills",
  "build/mcp-server",
  "build/chatgpt-ui",
  "build/auth",
  "build/monetization",
  "build/examples",
  "deploy/connect-chatgpt",
  "deploy/submission",
  "deploy/submission-errors",
  "deploy/troubleshooting",
  "guides/optimize-metadata",
  "guides/submit-claude-plugin",
  "guides/product-checkout-conversion-spec",
] as const;

/**
 * Normative pages that are NOT under the plugins base — help-centre articles
 * served as HTML with no Markdown twin.
 *
 * Carried as explicit `{page, url}` pairs because there is no shared base to
 * derive them from, and because a corpus that silently dropped them would grade
 * against a policy the submitter is still held to.
 */
export const OPENAI_EXTERNAL_POLICY_PAGES = [
  {
    page: "help/plugins-in-chatgpt-and-codex",
    url: "https://help.openai.com/en/articles/20001256-plugins-in-chatgpt-and-codex",
  },
  {
    page: "help/submitting-apps-to-the-chatgpt-app-directory",
    url: "https://help.openai.com/en/articles/20001040-submitting-apps-to-the-chatgpt-app-directory",
  },
] as const;

export type OpenAIPluginsPolicyPage =
  (typeof OPENAI_PLUGINS_POLICY_PAGES)[number];
export type OpenAIExternalPolicyPage =
  (typeof OPENAI_EXTERNAL_POLICY_PAGES)[number]["page"];

/** Every page in the corpus, whichever host serves it. */
export type OpenAIPolicyPage =
  | OpenAIPluginsPolicyPage
  | OpenAIExternalPolicyPage;

export const OPENAI_POLICY_PAGES: readonly OpenAIPolicyPage[] = [
  ...OPENAI_PLUGINS_POLICY_PAGES,
  ...OPENAI_EXTERNAL_POLICY_PAGES.map((entry) => entry.page),
];

/** How a page's revision is taken: over its Markdown twin, or its HTML text. */
export type OpenAIPolicyPageFormat = "markdown" | "html";

export interface OpenAIPolicySourceEntry {
  page: OpenAIPolicyPage;
  url: string;
  /**
   * The exact bytes the sync hashes. For the plugins corpus this is the `.md`
   * twin, which is why it is recorded rather than reconstructed at read time:
   * a check's citation should point a human at the rendered page, and the sync
   * at the machine-readable one.
   */
  revisionUrl: string;
  format: OpenAIPolicyPageFormat;
  /**
   * Content hash at {@link snapshotDate}, or `null` when the sync script has
   * not run. Never fabricated — see the module docblock.
   */
  revision: string | null;
  snapshotDate: string;
}

/**
 * A finding's citation: which page, and where on it.
 *
 * `section` is free text on purpose. Anchors churn faster than prose, and a
 * reader who is handed "the §Submission → Scan tools heading" can find it in a
 * reorganised page; a dead `#anchor` helps nobody.
 */
export interface OpenAIPolicySourceRef {
  page: OpenAIPolicyPage;
  section: string;
  url: string;
  revision: string | null;
  snapshotDate: string;
}

/**
 * Content hashes of each page, keyed by page.
 *
 * GENERATED — do not edit by hand; run `npm run openai-policy:sync`. A page
 * absent from this map has never been fetched and reports `revision: null`.
 */
// BEGIN GENERATED — sync via `npm run openai-policy:sync`
const PAGE_REVISIONS: Partial<Record<OpenAIPolicyPage, string>> = {};
// END GENERATED

const ENTRIES: OpenAIPolicySourceEntry[] = [
  ...OPENAI_PLUGINS_POLICY_PAGES.map((page) => ({
    page: page as OpenAIPolicyPage,
    url: `${OPENAI_PLUGINS_DOCS_BASE_URL}/${page}`,
    revisionUrl: `${OPENAI_PLUGINS_DOCS_BASE_URL}/${page}.md`,
    format: "markdown" as const,
    revision: PAGE_REVISIONS[page] ?? null,
    snapshotDate: OPENAI_POLICY_SNAPSHOT_DATE,
  })),
  ...OPENAI_EXTERNAL_POLICY_PAGES.map((entry) => ({
    page: entry.page as OpenAIPolicyPage,
    url: entry.url,
    revisionUrl: entry.url,
    format: "html" as const,
    revision: PAGE_REVISIONS[entry.page] ?? null,
    snapshotDate: OPENAI_POLICY_SNAPSHOT_DATE,
  })),
];

/** The manifest, keyed by page. Total over {@link OPENAI_POLICY_PAGES}. */
export const OPENAI_POLICY_MANIFEST: Readonly<
  Record<OpenAIPolicyPage, OpenAIPolicySourceEntry>
> = Object.freeze(
  Object.fromEntries(ENTRIES.map((entry) => [entry.page, entry])) as Record<
    OpenAIPolicyPage,
    OpenAIPolicySourceEntry
  >,
);

/**
 * Build a finding's citation.
 *
 * Findings call this rather than composing a ref by hand, so a page's URL,
 * revision and snapshot date can only ever come from the manifest — the whole
 * point being that no finding can cite a source the manifest does not track.
 */
export function openaiPolicySource(
  page: OpenAIPolicyPage,
  section: string,
): OpenAIPolicySourceRef {
  const entry = OPENAI_POLICY_MANIFEST[page];
  return {
    page: entry.page,
    section,
    url: entry.url,
    revision: entry.revision,
    snapshotDate: entry.snapshotDate,
  };
}

/**
 * Whether this corpus has actually been snapshotted.
 *
 * Surfaces show it next to a grade: "graded against an unverified policy
 * snapshot" is a materially weaker claim than "graded against the corpus as of
 * 2026-08-19", and collapsing the two would misrepresent the product.
 */
export function isOpenAIPolicyCorpusVerified(): boolean {
  return Object.values(OPENAI_POLICY_MANIFEST).every(
    (entry) => entry.revision !== null,
  );
}
