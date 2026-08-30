/**
 * The inspector-side half of the Wave-0 batch authoring contract.
 *
 * Every first-party authoring path — `authorEvalSuite`, the public single and
 * batch case routes, the generation persist loop — writes through the backend's
 * `testSuites:createTestCases`. Before this module each of them looped
 * `testSuites:createTestCase` once per case, so converting a repo's 40 test
 * files cost 40 sequential round trips and each case's write was its own
 * transaction. One mutation per chunk replaces that.
 *
 * Two things live here rather than at each call site, because three call sites
 * getting them subtly different is the failure this module exists to prevent:
 *
 *   - CHUNKING at the backend's cap. The cap is deliberately smaller than the
 *     suite file's 500-case limit, so a maximal file is expected to upload in
 *     several calls; chunking is normal operation, not an error path.
 *   - MINTING. Callers mint declared ids (`mintCaseId`), Convex validates the
 *     charset and suite-scoped uniqueness and never derives one. A minted `c_`
 *     id is a declared identity and lands in `declaredCaseId`; it is never
 *     written into the random `ui_*` storage `caseKey`.
 */
import { MAX_BATCH_CREATE_CASES, mintCaseId } from "@mcpjam/sdk/contract";
import type { EvalSuiteFileCaseImport } from "@mcpjam/sdk/contract";

/**
 * Cases accepted by one `createTestCases` call.
 *
 * Re-exported from the SDK contract rather than restated: the platform mutation
 * enforces the same number, and a third copy of it here is how a client ends up
 * chunking to a limit the backend no longer has. Deliberately NOT the suite
 * file's 500-case cap — see the note beside both constants.
 */
export const MAX_CASES_PER_BATCH = MAX_BATCH_CREATE_CASES;

/** `block` (default) | `warn` | `create_anyway`. */
export type DuplicatePolicy = "block" | "warn" | "create_anyway";

export interface CaseBatchWarning {
  code: string;
  message: string;
}

/** One case in a batch. The authored fields the backend's item validator takes. */
export type EvalCaseBatchItem = Record<string, unknown> & {
  title: string;
  /**
   * Optional analytics label. `null` is reserved for an explicit clear on an
   * authoritative write; omitted means no intent was supplied.
   */
  intent?: string | null;
  /** Declared identity. Minted by the caller; never derived by the backend. */
  caseId?: string;
  /** Per-item write key, derived caller-side (see utils/idempotency.ts). */
  idempotencyKey?: string;
  /**
   * The converter's CLAIM about this case, when it was imported rather than
   * authored here.
   *
   * Named on the type — rather than left to the index signature — because this
   * is the one field whose absence is silent and permanent: a batch that
   * dropped it persists a converted case as if a human had written it, and
   * nothing downstream can tell the difference afterwards. The backend's item
   * validator owns the bounds; this side owns not losing it.
   *
   * CLAIM-ONLY. Approval is a per-run decision the platform derives from the
   * authenticated launcher and freezes into the run snapshot; it never travels
   * with a case.
   */
  import?: EvalCaseImportClaim;
};

/**
 * The claim-only import record a case carries.
 *
 * `exact` is CONVERTER-CLAIMED exact — a mapping rule the converter says it
 * applied — and never an MCPJam verification of semantic equivalence.
 *
 * RE-EXPORTED from the suite-file contract rather than restated: a claim a
 * converter writes into a file is exactly the claim this batch carries, and a
 * second spelling is only an opportunity for the two to disagree.
 */
export type EvalCaseImportClaim = EvalSuiteFileCaseImport;

export interface CaseBatchCommittedEntry {
  /** Index into the ORIGINAL item list, not the chunk that carried it. */
  index: number;
  title: string;
  testCaseId: string;
  /** The EFFECTIVE declared id — on a replay this is the stored row's, not ours. */
  caseId?: string;
  replayed: boolean;
  warnings?: CaseBatchWarning[];
}

export interface CaseBatchFailedEntry {
  index: number;
  title?: string;
  caseId?: string;
  /** Stable machine-readable code from the backend (e.g. DUPLICATE_CASE_ID). */
  code: string;
  message: string;
}

export interface CaseBatchResult {
  committed: CaseBatchCommittedEntry[];
  failed: CaseBatchFailedEntry[];
  /** Policy normalization audit — a coercion is reported, never silently applied. */
  duplicatePolicy: {
    requestedPolicy?: string;
    effectivePolicy: string;
    coerced: boolean;
  };
  warnings: CaseBatchWarning[];
}

/**
 * Just the one method this module calls. Named function references are typed
 * against generated Convex API types the inspector does not have, which is why
 * every call site here and in `evals.ts` passes a `"module:fn" as any` string.
 */
type ConvexMutationClient = {
  mutation: (name: any, args: any) => Promise<any>;
};

/**
 * A chunk was rejected AFTER an earlier chunk had already committed.
 *
 * The rejection still propagates — a whole-call error is a caller-level
 * mistake, not a per-item outcome — but it carries what did land. Without that,
 * a caller writing 250 cases whose second chunk is refused would report all 250
 * as failed while 100 sit persisted in the suite, and a retry would author them
 * a second time.
 *
 * `partial` is empty when the FIRST chunk failed, which is the common case and
 * the one where "nothing was written" is simply true.
 */
export class CaseBatchPartialFailureError extends Error {
  readonly partial: CaseBatchResult;
  constructor(cause: unknown, partial: CaseBatchResult) {
    super(cause instanceof Error ? cause.message : String(cause));
    this.name = "CaseBatchPartialFailureError";
    this.cause = cause;
    this.partial = partial;
  }
}

/**
 * The committed/failed entries a rejection carried, or empty when it carried
 * none. Lets a catch site report what landed without knowing this module's
 * error type.
 */
export function partialResultOf(error: unknown): CaseBatchResult {
  return error instanceof CaseBatchPartialFailureError
    ? error.partial
    : {
        committed: [],
        failed: [],
        duplicatePolicy: DEFAULT_POLICY,
        warnings: [],
      };
}

const DEFAULT_POLICY = {
  effectivePolicy: "block",
  coerced: false,
} as const;

/**
 * Give every case a declared identity, keeping one the caller already chose.
 *
 * An id the caller supplies is passed through verbatim rather than validated
 * here: the backend owns the charset rule (`DECLARED_CASE_ID_PATTERN`), and a
 * second copy of it on this side is the drift this arrangement avoids. An
 * unusable id comes back as that item's failure, which is where a caller can
 * act on it.
 */
export function withMintedCaseIds<T extends { caseId?: string }>(
  items: T[]
): T[] {
  return items.map((item) =>
    item.caseId === undefined ? { ...item, caseId: mintCaseId() } : item
  );
}

/** Split into chunks the backend will accept. */
export function chunkCases<T>(items: T[], size = MAX_CASES_PER_BATCH): T[][] {
  if (size < 1) throw new RangeError("chunk size must be at least 1");
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}

/**
 * Author `items` through `testSuites:createTestCases`, one mutation per chunk.
 *
 * Entry indices are rewritten from chunk-local to GLOBAL, so a caller that
 * passed 250 cases reads `index` against the list it actually sent. Without
 * that, item 137's failure would report as index 37 and name the wrong case.
 *
 * A chunk that throws is not swallowed into per-item failures. The backend
 * rejects a whole call only for a caller-level mistake — bad args, no items,
 * over the cap, unauthorized — and every one of those is wrong for the entire
 * request, not for one case. Filing them as per-item failures would report an
 * auth error as 100 separate "case failed" lines.
 *
 * It does NOT throw the entries away, though. Chunks are separate
 * transactions, so a rejection at chunk 2 leaves chunk 1 persisted; the
 * rejection carries those committed entries (see
 * {@link CaseBatchPartialFailureError} and {@link partialResultOf}) so a
 * caller reports what landed instead of a uniform failure it would retry into
 * duplicates.
 */
export async function createEvalCasesInBatches(
  convexClient: ConvexMutationClient,
  args: {
    suiteId: string;
    cases: EvalCaseBatchItem[];
    duplicatePolicy?: DuplicatePolicy | string;
    overrideReason?: string;
  }
): Promise<CaseBatchResult> {
  const committed: CaseBatchCommittedEntry[] = [];
  const failed: CaseBatchFailedEntry[] = [];
  const warnings: CaseBatchWarning[] = [];
  // The backend normalizes the policy per call, and every chunk of one request
  // sends the same value — so the last chunk's audit describes them all. An
  // empty request never reaches the backend, so state the default it would have
  // applied rather than inventing a third answer.
  let duplicatePolicy: CaseBatchResult["duplicatePolicy"] = {
    requestedPolicy: args.duplicatePolicy,
    effectivePolicy: "block",
    coerced: false,
  };

  const chunks = chunkCases(args.cases);
  let offset = 0;
  for (const chunk of chunks) {
    let response: any;
    try {
      response = await convexClient.mutation(
        "testSuites:createTestCases" as any,
        {
          suiteId: args.suiteId,
          cases: chunk,
          ...(args.duplicatePolicy
            ? { duplicatePolicy: args.duplicatePolicy }
            : {}),
          ...(args.overrideReason
            ? { overrideReason: args.overrideReason }
            : {}),
        }
      );
    } catch (error) {
      // Earlier chunks are already persisted and cannot be taken back — this
      // is several transactions, not one. Carry them on the rejection so the
      // caller reports what landed instead of a uniform failure it would then
      // retry into duplicates.
      throw new CaseBatchPartialFailureError(error, {
        committed,
        failed,
        duplicatePolicy,
        warnings,
      });
    }
    const chunkOffset = offset;
    for (const entry of response?.caseUpsert?.committed ?? []) {
      committed.push({ ...entry, index: chunkOffset + entry.index });
    }
    for (const entry of response?.caseUpsert?.failed ?? []) {
      failed.push({ ...entry, index: chunkOffset + entry.index });
    }
    for (const warning of response?.warnings ?? []) {
      warnings.push(warning);
    }
    if (response?.duplicatePolicy) {
      duplicatePolicy = response.duplicatePolicy;
    }
    offset += chunk.length;
  }

  return { committed, failed, duplicatePolicy, warnings };
}
