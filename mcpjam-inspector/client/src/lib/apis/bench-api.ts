/**
 * Connector Bench client.
 *
 * Two fetch flavours, deliberately:
 *
 *  - The authed calls use `authFetch`, which attaches the hosted bearer for
 *    `/api/web/*` and re-mints it on a 401. A preflight, quote, run or cancel
 *    is spent on behalf of a specific actor and the relay forwards that bearer
 *    to the backend as the second token.
 *  - `fetchBenchResult` uses a plain `fetch`, for the same reason the score
 *    client does: a `/results/<secret>` visitor may have no session, no guest
 *    cookie and no project, and `authFetch` would mint a guest session just to
 *    read a public document. The secret in the URL is the whole credential.
 */

import { authFetch } from "@/lib/session-token";

const BASE = "/api/web/bench";

/** One runnable slice of the bench, as the backend classified this target. */
/**
 * Mirrors the preflight response's `categories[]` exactly. `id` is the
 * taxonomy category slug.
 */
export interface BenchCategory {
  id: string;
  title: string;
  description: string;
  /** The classifier's ranking, when this category was one of the ranked ones. */
  confidence?: number;
  /**
   * False when no active definition exists for this category — offering it
   * would produce a start request that can only be refused.
   */
  runnable: boolean;
}

/** A named bundle of categories the score site offers as one choice. */
/**
 * Mirrors the preflight response's `tracks[]` exactly. `id` is
 * `${profileId}@${version}` and is for display and selection; the QUOTE is
 * priced from `profileId` (plus `version` as `profileVersion`), so both are
 * carried separately rather than parsed back out of `id`.
 */
export interface BenchTrack {
  id: string;
  definitionId: string;
  profileId: string;
  version: string;
  kind: string;
  /** The taxonomy category this track exams, when it is category-scoped. */
  categoryId?: string;
  definitionHash: string;
  /**
   * True when the exam performs writes against the target, so the quote screen
   * must take explicit consent before starting.
   */
  writesToTarget: boolean;
}

/** What the caller wants run. IDs come from the preflight response. */
export interface BenchSelection {
  categoryIds?: string[];
  trackIds?: string[];
  actorIds?: string[];
}

/**
 * One ranked line of the classification receipt.
 *
 * Ranked best-first by the backend, ties broken by slug so the order is
 * stable across two reads of the same receipt.
 */
export interface BenchRankedCategory {
  categorySlug: string;
  /** 0–1. Rendered as the classifier's own confidence, never as a score. */
  confidence: number;
  rationale?: string;
}

/**
 * What the classifier made of this target's tool surface.
 *
 * `ranked` ABSENT means the classifier did not produce a ranking — it failed,
 * timed out, or has no opinion. That is not a reason to block a run: the
 * selector falls back to the full runnable list, and the visitor picks. A
 * classifier is a convenience, and a broken convenience must not become a
 * gate.
 */
export interface BenchClassification {
  ranked?: BenchRankedCategory[];
  taxonomyVersion?: string;
  classifierVersion?: string;
  /** Set when the classifier ran and failed, as opposed to never running. */
  failureReason?: string;
}

/** The per-actor prefill the backend remembers for one target. */
export interface BenchPreferences extends Record<string, unknown> {
  categorySlug?: string;
  trackSlug?: string;
}

/** What the caller agreed to before anything is spent against the target. */
export interface BenchConsent {
  authenticatedChecks?: boolean;
  writeCases?: boolean;
}

export interface BenchPreflight {
  /**
   * The stable target the backend resolved or minted for this saved server.
   * Quotes are priced against THIS, not against the server row — carry it
   * into `quoteBench`.
   */
  benchmarkTargetId: string;
  /** Binds a later quote and run to the classification shown here. */
  receiptId: string;
  /** The taxonomy the categories below were drawn from. */
  taxonomyVersion?: string;
  /** True when the classification was served from cache rather than computed. */
  cached?: boolean;
  categories: BenchCategory[];
  tracks: BenchTrack[];
  classification?: BenchClassification;
  /** Per-actor prefill the backend remembers for this caller, if any. */
  preferences?: BenchPreferences;
  /** How many tools the relay captured, and whether it had to stop early. */
  toolCount: number;
  toolSnapshotTruncated: boolean;
}

/**
 * One case's declared side effects, exactly as the pinned manifest resolves
 * them. `read_only` carries nothing else — the absence of the other fields IS
 * the statement.
 */
export type BenchCaseSideEffects =
  | { mode: "read_only" }
  | {
      mode: "test_write";
      /** "creates a page, then deletes it" — the manifest's own words. */
      summary: string;
      allowedTools: string[];
      createRules: Array<{
        tool: string;
        artifactNamePath: string;
        /** Every artifact this case creates is named under this prefix. */
        requiredPrefix: string;
        createdIdResultPaths: string[];
      }>;
      mutationTargetPaths: string[];
      cleanupSteps: Array<Record<string, unknown>>;
    };

/**
 * The definition's pinned per-case metadata.
 *
 * The backend OMITS this rather than sending `{}` when a definition authors no
 * per-case metadata, because "declares no side effects" and "declares an empty
 * set of them" are different statements about what a run may do. Treat absence
 * as unknown, never as read-only — see `benchWriteOperations`.
 */
export interface BenchWriteManifest {
  suiteHash: string;
  cases: Array<{
    caseId: string;
    icpSlugs?: string[];
    goalSlugs?: string[];
    sideEffects: BenchCaseSideEffects;
  }>;
}

/** One write case, flattened for display on the consent screen. */
export interface BenchWriteOperation {
  caseId: string;
  summary: string;
  allowedTools: string[];
  /** The prefixes every artifact this case creates is named under. */
  requiredPrefixes: string[];
}

/**
 * The write cases a quote covers, for the consent screen.
 *
 * Returns `null` — NOT an empty list — when the quote says it writes but the
 * manifest cannot be read. The caller must fail closed on that: an empty list
 * renders as "this exam only reads", which is precisely the false reassurance
 * that must never be shown about a run that writes into someone's tenant.
 */
export function benchWriteOperations(
  quote: BenchQuote | null | undefined,
): BenchWriteOperation[] | null {
  if (!quote?.writesToTarget) return [];
  const cases = quote.writeManifest?.cases;
  if (!Array.isArray(cases)) return null;
  const operations = cases.flatMap((entry) =>
    entry?.sideEffects?.mode === "test_write"
      ? [
          {
            caseId: entry.caseId,
            summary: entry.sideEffects.summary,
            allowedTools: entry.sideEffects.allowedTools ?? [],
            requiredPrefixes: (entry.sideEffects.createRules ?? []).map(
              (rule) => rule.requiredPrefix,
            ),
          },
        ]
      : [],
  );
  // A quote that writes but names no write case is a manifest we failed to
  // understand, not a read-only exam.
  return operations.length > 0 ? operations : null;
}

/**
 * The estimate, in the backend's own line items.
 *
 * Micros of USD, integer. Rendered, never recombined: a total this client
 * computed would disagree with the ceiling admission actually holds the moment
 * the backend adds a line item.
 */
export interface BenchEstimateBreakdown {
  cellsMicros?: number;
  judgesMicros?: number;
  classifierMicros?: number;
  analyzerMicros?: number;
}

/** The exam a quote priced, by the identity a rerun has to match. */
export interface BenchDefinitionIdentity {
  definitionId?: string;
  profileId?: string;
  version?: string;
  kind?: string;
  definitionHash?: string;
  categorySlug?: string;
  taxonomyVersion?: string;
  /**
   * The hash of the write manifest being consented to. Nested HERE, inside
   * `definition`, which is where the backend puts it — a top-level read finds
   * nothing. Carried back with the run so a definition that gained a write
   * case between quote and start cannot be admitted against consent given for
   * a read-only exam.
   */
  consentManifestHash?: string;
}

/** How big the run is, in the units a visitor waits through. */
export interface BenchRunPlan {
  cases?: number;
  cells?: number;
  repetitions?: number;
  estimatedWallClockMs?: number;
}

/**
 * What a guest is spending, and what they get back.
 *
 * `contributionMicros` is taken as a LUMP at admission and is deliberately
 * non-refundable — the daily buckets roll and there is no reconciliation
 * machinery to hand part of one back. The quote screen says so; it is not a
 * thing to discover after a cancelled run.
 */
export interface BenchGuestTerms {
  runsRemainingToday?: number;
  dailyRunLimit?: number;
  contributionMicros?: number;
  /** Set when the guest's own balance would cover the run outright. */
  coveredByBalance?: boolean;
}

export interface BenchQuote {
  quoteId?: string;
  definition?: BenchDefinitionIdentity;
  /** `estimateBreakdown` is the backend's name; there is no `estimate`. */
  estimateBreakdown?: BenchEstimateBreakdown;
  /** The ceiling admission holds. Never the expected cost — the worst case. */
  quotedMaxMicros?: number;
  /** What the payer has to spend it from. `null` when the backend won't say. */
  availableMicros?: number | null;
  payerKind?: "org_credits" | "guest_subsidy";
  plan?: BenchRunPlan;
  /**
   * Whether this exam writes to the target at all. THE authority on that
   * question — derived by the backend from the definition's own cases, not
   * inferred from whether a manifest happens to be present.
   */
  writesToTarget?: boolean;
  /**
   * The pinned per-case manifest describing those writes. Omitted rather than
   * emptied when the definition authors none, so its absence next to
   * `writesToTarget: true` means "we could not read the manifest", not
   * "nothing is written". Use `benchWriteOperations` rather than reading this
   * directly.
   */
  writeManifest?: BenchWriteManifest;
  /** Epoch ms. Quotes are short-lived; past this one, re-quote. */
  expiresAt?: number;
  guest?: BenchGuestTerms;
  [key: string]: unknown;
}

/**
 * The run lifecycle, exactly as the backend spells it.
 *
 *   queued → running → awaiting_evidence → assembling
 *          → completed | provisional | insufficient_evidence
 *
 * with `cancelled` and `failed` as exceptional exits. `failed` means MCPJam
 * could not produce a valid interpretation — a target that failed every check
 * still `completed`, holding a bad score. Collapsing the two would let an
 * outage read as a verdict.
 */
export type BenchRunStatus =
  | "queued"
  | "running"
  | "awaiting_evidence"
  | "assembling"
  | "completed"
  | "provisional"
  | "insufficient_evidence"
  | "failed"
  | "cancelled";

export interface BenchRunProgress {
  cellsTotal?: number;
  cellsCompleted?: number;
  casesTotal?: number;
  casesCompleted?: number;
  repetitionsTotal?: number;
  repetitionsCompleted?: number;
}

/** The run's own spend against its quote, not the org's daily budget. */
export interface BenchRunBudget {
  quotedMaxMicros?: number;
  chargedMicros?: number;
  reservedMicros?: number;
  status?: "active" | "exhausted" | "settled";
}

/**
 * Whether everything this run wrote has been taken back.
 *
 * Reported even on a failed run: cleanup is ledger-driven and independent of
 * any model call, so budget exhaustion never skips it, and a visitor who let
 * us write into their tenant is owed the answer either way.
 */
export interface BenchRunCleanup {
  status?: "pending" | "running" | "complete" | "residue" | "not_applicable";
  residueCount?: number;
  detail?: string;
}

export interface BenchRun {
  benchmarkRunId: string;
  status: BenchRunStatus;
  profile?: { id: string; version: string; definitionHash: string };
  targetKey?: string;
  verification?: string;
  createdAt?: number;
  startedAt?: number;
  /** `completedAt` is the backend's name for it; there is no `finishedAt`. */
  completedAt?: number;
  progress?: BenchRunProgress;
  budget?: BenchRunBudget;
  cleanup?: BenchRunCleanup;
  /** True between a cancel request and the worker actually stopping. */
  cancelRequested?: boolean;
  failureCode?: string;
  failureMessage?: string;
  /** The job row's lease state, when the run has one. */
  job?: Record<string, unknown>;
  /**
   * Returned ONLY by the start call, and only by the invocation that actually
   * stored its hash — the backend keeps a digest, so the plaintext exists
   * exactly once and a poll can never hand it back. Whoever starts a run has
   * to hold on to it; it is not recoverable from `/runs/:runId`.
   */
  resultSecret?: string;
}

export const BENCH_TERMINAL_RUN_STATUSES: ReadonlySet<BenchRunStatus> = new Set(
  [
    "completed",
    "provisional",
    "insufficient_evidence",
    "failed",
    "cancelled",
  ],
);

export function isTerminalBenchRunStatus(status: BenchRunStatus): boolean {
  return BENCH_TERMINAL_RUN_STATUSES.has(status);
}

/** Coverage vocabulary shared by sections and pillars. */
export type BenchCoverage =
  | "eligible"
  | "provisional"
  | "insufficient_evidence"
  | "not_applicable";

export interface BenchSection {
  section: "coreProtocol" | "protocolExtensions" | "workflowReliability";
  coverage: BenchCoverage;
  /** 0–100. `null` when the section produced no number. */
  score: number | null;
  components?: Array<{
    key: string;
    score: number | null;
    coverage: BenchCoverage;
  }>;
}

export type BenchSectionKey = BenchSection["section"];

/**
 * A slice of the same case outcomes the headline is built from, selected by
 * the definition's pinned per-case tags.
 *
 * `score: null` with `casesScored: 0` is the honest answer for a persona
 * nothing measured, and MUST NOT render as zero — "this connector scores 0 for
 * support agents" and "no case in this exam represents a support agent" are
 * different claims, and only one of them is about the connector.
 */
export interface BenchSlice {
  kind: "icp" | "goal";
  slug: string;
  label?: string;
  score: number | null;
  casesScored: number;
  casesTagged: number;
}

/**
 * The scorecard as read back.
 *
 * `sections` is ABSENT under the v1 scorer — the read gates on a persisted
 * scoring-algorithm version rather than on the shape of the numbers. That
 * absence is the ONLY signal a reader gets, and it has to be the one they use:
 * `coreScore` and `compositeScore` are populated for v1 rows too, so a
 * null-filled `sections` object would have been the v1 pooled numbers wearing
 * section names. `composite` is an alias of `overall` only when `sections`
 * exists; on its own it is the v1 pooled number and must be labelled as one.
 */
export interface BenchScorecard {
  status: "scored" | "provisional" | "partial" | "insufficient_evidence";
  definitionHash?: string;
  evidenceDigest?: string;
  verification?: "mcpjam_verified" | "client_reported" | "mixed";
  scores?: {
    core: number | null;
    category: number | null;
    composite: number | null;
  };
  sections?: {
    coreProtocol: BenchSection;
    protocolExtensions: BenchSection;
    workflowReliability: BenchSection;
    /** `null` unless BOTH Core Protocol and Workflow Reliability produced one. */
    overall: number | null;
    /** Applicable sections that produced no number, named. */
    unmeasured?: BenchSectionKey[];
  };
  slices?: BenchSlice[];
  provisionalReasons?: string[];
  /**
   * The scorer's own eligibility verdict. A bare boolean on the scorecard —
   * it is NOT an object, and it is not `publication`.
   */
  publicEligible?: boolean;
  /**
   * The publication LIFECYCLE, and it lives HERE rather than on the result:
   * the backend nests lifecycle state with the document it describes. A
   * deprecated or deleted result still resolves — a link somebody shared
   * should explain itself rather than 404 — and must be labelled as such.
   */
  publication?: {
    status: "active" | "deprecated" | "deleted";
    reason?: string;
  };
}

/**
 * Where the category being scored against came from.
 *
 * `userSelected` is the difference between a visitor saying "score this as a
 * CRM" and a reviewed registry assignment saying it is one. Both produce a
 * real measurement; only the second may ever back a public claim.
 */
export interface BenchCategoryProvenance {
  slug?: string;
  label?: string;
  source?: string;
  status?: "proposed" | "approved" | "rejected" | "superseded";
  userSelected?: boolean;
}

/** The public artifact behind a result link. */
export interface BenchResult extends Record<string, unknown> {
  runId?: string;
  finishedAt?: number;
  targetLabel?: string;
  definition?: BenchDefinitionIdentity;
  category?: BenchCategoryProvenance;
  scorecard?: BenchScorecard;
  cleanup?: BenchRunCleanup;
  /** Set when a newer definition of the same profile exists. */
  rerun?: {
    /** The version a same-hash rerun would use. */
    sameHashVersion?: string;
    /** The version a NEW exam would use — a new comparison series. */
    latestVersion?: string;
    definitionHashChanged?: boolean;
  };
}

export class BenchNotEnabledError extends Error {}
export class BenchResultNotFoundError extends Error {}

/**
 * The exam moved between the quote and the start.
 *
 * Its own type because it is the one 409 with a recovery: re-quote and show
 * the visitor what changed. Every other conflict is a run that is no longer in
 * the state the caller thought it was, which is not re-quotable.
 */
export class BenchDefinitionChangedError extends Error {}

async function readError(response: Response, fallback: string) {
  const body = (await response.json().catch(() => null)) as {
    message?: string;
    error?: string;
  } | null;
  return body?.message ?? body?.error ?? fallback;
}

/**
 * The relay answers a backend that has not enabled benchmark runs with a 503
 * carrying FEATURE_NOT_SUPPORTED. That is a deployment state, not a failure of
 * this request, so it gets its own error type — callers hide the entry point
 * rather than showing a retry.
 */
async function throwFromResponse(
  response: Response,
  fallback: string,
): Promise<never> {
  const body = (await response.json().catch(() => null)) as {
    code?: string;
    message?: string;
    error?: string;
    details?: { code?: string };
  } | null;
  const message = body?.message ?? body?.error ?? fallback;
  if (response.status === 503 && body?.code === "FEATURE_NOT_SUPPORTED") {
    throw new BenchNotEnabledError(message);
  }
  // The relay maps every backend 409 to CONFLICT and forwards the backend's
  // own envelope as `details`, so the specific conflict is read from there
  // rather than from the relay's coarser code.
  if (response.status === 409 && body?.details?.code === "DEFINITION_CHANGED") {
    throw new BenchDefinitionChangedError(message);
  }
  throw new Error(message);
}

async function benchPost<T>(
  path: string,
  payload: Record<string, unknown>,
  fallback: string,
): Promise<T> {
  const response = await authFetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!response.ok) await throwFromResponse(response, fallback);
  return (await response.json()) as T;
}

export async function preflightBench(input: {
  projectId: string;
  serverId: string;
}): Promise<BenchPreflight> {
  return benchPost<BenchPreflight>(
    "/preflight",
    input,
    "Could not prepare this benchmark.",
  );
}

/**
 * `benchmarkTargetId` and `profileId` are NOT optional to the backend — it
 * refuses the call without them. Both come out of the preflight response:
 * the target id at its top level, the profile from whichever entry of
 * `tracks` the caller picked. Quoting against the saved server row instead
 * was the original mistake here; a quote is priced against the stable target
 * and one exact exam definition.
 */
export async function quoteBench(input: {
  projectId: string;
  serverId: string;
  benchmarkTargetId: string;
  profileId: string;
  profileVersion?: string;
  consent?: BenchConsent;
  selection?: BenchSelection;
}): Promise<BenchQuote> {
  return benchPost<BenchQuote>(
    "/quotes",
    input,
    "Could not price this benchmark.",
  );
}

/**
 * Starting a run is ACCEPTING a quote, so it carries the `quoteId` the quote
 * call returned. The backend re-checks that quote's definition and consent
 * hashes and refuses with a conflict if the exam moved underneath it — which
 * is why a start cannot be assembled from the target alone.
 */
export async function startBenchRun(input: {
  projectId: string;
  serverId: string;
  quoteId: string;
  receiptId: string;
  consent?: BenchConsent;
  idempotencyKey?: string;
  selection?: BenchSelection;
  preferences?: BenchPreferences;
}): Promise<BenchRun> {
  return benchPost<BenchRun>(
    "/runs",
    input,
    "Could not start this benchmark run.",
  );
}

export async function fetchBenchRun(runId: string): Promise<BenchRun> {
  const response = await authFetch(`${BASE}/runs/${encodeURIComponent(runId)}`);
  if (!response.ok) {
    await throwFromResponse(response, "Could not load this benchmark run.");
  }
  return (await response.json()) as BenchRun;
}

export async function cancelBenchRun(runId: string): Promise<BenchRun> {
  const response = await authFetch(
    `${BASE}/runs/${encodeURIComponent(runId)}/cancel`,
    { method: "POST" },
  );
  if (!response.ok) {
    await throwFromResponse(response, "Could not cancel this benchmark run.");
  }
  return (await response.json()) as BenchRun;
}

export async function fetchBenchResult(secret: string): Promise<BenchResult> {
  const response = await fetch(`${BASE}/results/${encodeURIComponent(secret)}`);
  if (response.status === 404) {
    throw new BenchResultNotFoundError(
      await readError(
        response,
        "That result link is not valid, or the run no longer exists.",
      ),
    );
  }
  if (!response.ok) {
    await throwFromResponse(response, "Could not load this benchmark result.");
  }
  const body = (await response.json()) as { result?: BenchResult };
  if (!body.result) throw new Error("Could not load this benchmark result.");
  return body.result;
}
