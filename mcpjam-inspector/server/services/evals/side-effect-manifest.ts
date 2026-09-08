/**
 * The pinned per-case side-effect manifest, and the small amount of reading it
 * takes to enforce one.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHAT THE MANIFEST IS FOR
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * A benchmark write case creates things on a server somebody else operates.
 * The tool-policy gate can say WHICH tools may be called; it cannot say what
 * they may be called WITH, and "may call `create_page`" is not a bound on
 * anything — the same permission covers creating a page named for this run and
 * overwriting the operator's homepage.
 *
 * The manifest is the missing half: per case, pinned in the definition and
 * hashed into it, it names the tools the case may use, the argument that
 * carries the artifact's name, the prefix that name must carry, where a created
 * id shows up in the result, and which arguments name a thing the call is going
 * to mutate. Everything this module and the gate enforce is reproducible from
 * the pins alone, which is what makes a scorecard's write behaviour auditable
 * after the fact rather than a claim about what the harness did that day.
 *
 * VERIFY BEFORE EXECUTING, NOT AFTER. `assertCaseMetadataPinned` runs before a
 * cell is launched. A manifest that cannot be tied to the hash the job was
 * admitted under is not a manifest we may enforce — the definition may have
 * been republished between admission and execution, and running under rules
 * nobody consented to is worse than not running.
 */

/** The prefix every benchmark-created artifact's name must carry. */
export const BENCHMARK_ARTIFACT_PREFIX = "mcpjam-benchmark-";

export type CaseCreateRule = {
  tool: string;
  /**
   * Where in the call's ARGUMENTS the artifact's name lives.
   *
   * Required on every create rule, and duplicate create rules for one tool are
   * refused at publish time — so a lookup by tool name is unambiguous and a
   * create rule can never be "the one without a name path".
   */
  artifactNamePath: string;
  /** Pinned base of the run-scoped prefix; see {@link composeArtifactPrefix}. */
  requiredPrefix: string;
  /** Where in the call's RESULT the created id shows up. */
  createdIdResultPaths: string[];
};

export type CaseCleanupStep = {
  tool: string;
  /** Where the id to remove goes in the cleanup call's arguments. */
  idArgPath: string;
};

export type ResolvedCaseSideEffects =
  | { mode: "read_only" }
  | {
      mode: "test_write";
      summary: string;
      /**
       * EVERY tool the case may call, not only the mutating ones.
       *
       * A read that is not on the list is blocked like a write. That is
       * deliberate: the list is what makes a write case's blast radius
       * reviewable at publish time, and a manifest that silently permits
       * whatever it forgot to mention is not a bound.
       */
      allowedTools: string[];
      createRules: CaseCreateRule[];
      /**
       * Arguments that name a thing the call will mutate. Checked against the
       * run's artifact ledger: an update or a delete aimed at an id this run
       * did not create is somebody else's data.
       */
      mutationTargetPaths: string[];
      cleanupSteps: CaseCleanupStep[];
    };

/**
 * One case's manifest as the backend resolved it, with the stamp that ties it
 * to a definition.
 */
export type PinnedCaseSideEffects = {
  suiteHash: string;
  caseId: string;
  /** The aggregate hash of the definition's whole `caseMetadata` section. */
  caseMetadataHash: string;
  sideEffects: ResolvedCaseSideEffects;
};

export class CaseMetadataPinMismatchError extends Error {
  readonly code = "CASE_METADATA_PIN_MISMATCH";

  constructor(message: string) {
    super(message);
    this.name = "CaseMetadataPinMismatchError";
  }
}

/**
 * Refuse a manifest that is not the one the job was admitted under.
 *
 * The client cannot recompute the backend's aggregate hash from one case, and
 * pretending otherwise would be theatre. What it CAN do — and what actually
 * catches the risk — is insist that the manifest it is about to enforce
 * carries the same `caseMetadataHash` the claim pinned. A definition
 * republished between admission and execution changes that stamp, and the
 * write rules the payer consented to are then not the rules that would run.
 */
export function assertCaseMetadataPinned(args: {
  resolved: ReadonlyArray<PinnedCaseSideEffects>;
  expectedCaseMetadataHash: string | undefined;
  expectedSuiteHash?: string;
}): void {
  if (!args.expectedCaseMetadataHash) {
    throw new CaseMetadataPinMismatchError(
      "the claim pinned no caseMetadataHash, so a write manifest cannot be tied to the definition",
    );
  }
  for (const entry of args.resolved) {
    if (entry.caseMetadataHash !== args.expectedCaseMetadataHash) {
      throw new CaseMetadataPinMismatchError(
        `case "${entry.caseId}" resolved against a different caseMetadata generation than the job was admitted under`,
      );
    }
    if (
      args.expectedSuiteHash !== undefined &&
      entry.suiteHash !== args.expectedSuiteHash
    ) {
      throw new CaseMetadataPinMismatchError(
        `case "${entry.caseId}" resolved against suite ${entry.suiteHash}, not the pinned ${args.expectedSuiteHash}`,
      );
    }
  }
}

/**
 * The prefix an artifact created by THIS run, in THIS iteration, must carry.
 *
 * Per-iteration rather than per-run, so a list-style case cannot observe its
 * own sibling iterations' artifacts and grade a leak that is ours. The pinned
 * base comes from the manifest; the run and iteration come from the execution,
 * because a definition cannot know them.
 */
export function composeArtifactPrefix(args: {
  requiredPrefix: string;
  benchmarkRunId: string;
  iteration: number;
}): string {
  return `${args.requiredPrefix}${args.benchmarkRunId}-${args.iteration}`;
}

/**
 * Read every value a path selects.
 *
 * A LIST rather than one value, because `*` selects each element of an array
 * and a mutation-target path that selected only the first would let the rest
 * through unchecked. Segments are dot-separated; a numeric segment indexes an
 * array; `*` fans out over one.
 */
export function readManifestPath(root: unknown, path: string): unknown[] {
  if (path.length === 0) return [];
  let cursor: unknown[] = [root];
  for (const segment of path.split(".")) {
    const next: unknown[] = [];
    for (const value of cursor) {
      if (value === null || value === undefined) continue;
      if (segment === "*") {
        if (Array.isArray(value)) next.push(...value);
        continue;
      }
      if (Array.isArray(value)) {
        const index = Number(segment);
        if (Number.isInteger(index) && index >= 0 && index < value.length) {
          next.push(value[index]);
        }
        continue;
      }
      if (typeof value === "object") {
        const entry = (value as Record<string, unknown>)[segment];
        if (entry !== undefined) next.push(entry);
      }
    }
    if (next.length === 0) return [];
    cursor = next;
  }
  return cursor;
}

/**
 * Ids read out of a path, normalized.
 *
 * Numbers are accepted and stringified: an id is an id whether the server
 * spells it `42` or `"42"`, and refusing the numeric form would block a
 * cleanup for a target that did nothing wrong.
 */
export function readManifestIds(root: unknown, path: string): string[] {
  const ids: string[] = [];
  for (const value of readManifestPath(root, path)) {
    if (typeof value === "string" && value.length > 0) ids.push(value);
    else if (typeof value === "number" && Number.isFinite(value)) {
      ids.push(String(value));
    }
  }
  return ids;
}

/** The create rule for a tool, or undefined. Unambiguous by construction. */
export function createRuleForTool(
  sideEffects: Extract<ResolvedCaseSideEffects, { mode: "test_write" }>,
  toolName: string,
): CaseCreateRule | undefined {
  return sideEffects.createRules.find((rule) => rule.tool === toolName);
}
