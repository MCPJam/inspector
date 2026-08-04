/**
 * The public agent's operation registry — one entry per tool, and the single
 * place a new tool is declared.
 *
 * WHY A REGISTRY. Adding an operation to this surface used to mean editing
 * five places that had no way of knowing about each other: the op list, the
 * idempotency set, the proposal describer, the system prompt, and the Slack
 * app's button-label table. Four of those were hand-maintained lookups keyed by
 * operation name, so the failure mode of forgetting one was silent — a write
 * left out of the idempotency set quietly loses retry safety, a proposal with
 * no describer renders its raw operation name at a human, a tool with no prompt
 * note is one the model never learns when to reach for.
 *
 * So the entry carries the metadata and everything else is DERIVED:
 *
 *   - `AGENT_API_OPERATIONS` / `AGENT_API_GATED_OPERATIONS` — the two tiers.
 *   - `WRITE_OPERATION_NAMES` — direct ∧ !readOnly, read off the operation's
 *     own `readOnly` flag rather than restated. The op catalog already knows
 *     which operations persist; asking it is not just less typing, it is the
 *     only version of this set that cannot drift.
 *   - the proposal's human-facing copy (`describe`, `buttonLabel`, `kind`,
 *     `confirmSeverity`), which now travels IN the response envelope so a host
 *     renders what the server decided instead of re-deriving it from an
 *     operation name it happens to recognise.
 *   - the system prompt's operation-specific guidance (`promptNotes`).
 *
 * TIERS. `direct` executes. `gated` validates, persists a proposal, and
 * returns an opaque id for a human to approve — the tier for anything that
 * SPENDS or reaches outside MCPJam. The discriminated union makes `proposal`
 * mandatory on a gated entry at the type level, so a gated op cannot be added
 * without saying what its approval prompt says.
 *
 * NOT AN AUTHORIZATION BOUNDARY. The tier decides which tool the model is
 * offered; the clamp, the delegated JWT, and the proposal claim are what make
 * the call safe. A registry edit widens the surface — review it as one.
 */
import {
  cancelEvalRunOperation,
  createEvalCaseOperation,
  createEvalSuiteOperation,
  generateEvalCasesOperation,
  getEvalCaseOperation,
  getEvalRunOperation,
  getEvalRunStepsOperation,
  getEvalSuiteOperation,
  getHostOperation,
  listEnvironmentsOperation,
  listEvalCasesOperation,
  listEvalRunIterationsOperation,
  listEvalSuiteRunsOperation,
  listEvalSuitesOperation,
  listHostsOperation,
  listProjectServersOperation,
  listServerToolsOperation,
  runEvalCaseOperation,
  runEvalSuiteOperation,
  updateEvalCaseOperation,
  updateEvalSuiteOperation,
  type PlatformOperation,
} from "@mcpjam/sdk/platform";
import type {
  ExecutedActionResource,
  ProposedActionKind,
  ProposedActionSeverity,
} from "@mcpjam/sdk/public-api";
import { MCPJAM_HOSTED_ORIGIN } from "../../config.js";

/** Any catalog operation, input type erased — the registry is heterogeneous. */
export type AnyPlatformOperation = PlatformOperation<any, unknown>;

/**
 * The approval copy for a gated operation.
 *
 * All of it is SERVER-AUTHORED and travels in the envelope. A host renders it;
 * it never decides it. That is what lets a second host (Discord) ship without
 * a second copy of this table, and what lets a new gated op reach every host
 * the moment it lands here.
 */
export interface GatedProposalMeta {
  /**
   * A short, concrete summary of what a click will do.
   *
   * States the TARGET, not a cost: any number here would be an estimate, and
   * an estimate rendered next to an approval button reads as a promise. Runs
   * on VALIDATED input, so it can trust the shape — but the values are still
   * model-authored, so hosts escape it before rendering.
   */
  describe(input: Record<string, unknown>): string;
  /** Verb for the approval control. Hosts cap it to their own limit. */
  buttonLabel: string;
  kind: ProposedActionKind;
  /** Omitted when the host's default confirmation copy is honest enough. */
  confirmSeverity?: ProposedActionSeverity;
  /**
   * What the executed action produced, when it produced something linkable.
   *
   * Built HERE rather than by the host, because building it needs the
   * operation's result shape — and a host that knew every result shape would
   * silently start linking to nothing the moment one changed. Absent means the
   * action produces nothing to look at (a cancellation), which is different
   * from "the host could not work out a link".
   */
  resource?(
    result: unknown,
    context: { projectId: string }
  ): ExecutedActionResource | undefined;
}

/** Read a string off an unknown result, at a dotted path. */
function readString(source: unknown, path: string): string | undefined {
  let node: unknown = source;
  for (const key of path.split(".")) {
    if (!node || typeof node !== "object") return undefined;
    node = (node as Record<string, unknown>)[key];
  }
  return typeof node === "string" && node ? node : undefined;
}

/**
 * The run both run-ops produce, as a linkable resource.
 *
 * `?project=` makes the link self-describing: eval routes carry no project
 * segment, so without it the app renders whatever project the viewer's picker
 * was parked on — an empty state for everyone but the author.
 */
function evalRunResource(
  result: unknown,
  { projectId }: { projectId: string }
): ExecutedActionResource | undefined {
  const runId = readString(result, "runId");
  const suiteId = readString(result, "suite.id") ?? readString(result, "suiteId");
  if (!runId || !suiteId) return undefined;
  return {
    type: "eval_run",
    id: runId,
    url:
      `${MCPJAM_HOSTED_ORIGIN}/evals/suite/${encodeURIComponent(suiteId)}` +
      `/runs/${encodeURIComponent(runId)}?project=${encodeURIComponent(projectId)}`,
  };
}

interface BaseEntry {
  operation: AnyPlatformOperation;
  /**
   * Lines appended to the system prompt's ground rules, verbatim and in
   * registry order. For guidance that is SPECIFIC to this operation — when to
   * prefer it, what it costs, how to read its output. General rules belong in
   * the base prompt.
   */
  promptNotes?: readonly string[];
}

export type AgentOpEntry =
  | (BaseEntry & { tier: "direct" })
  | (BaseEntry & { tier: "gated"; proposal: GatedProposalMeta });

/** Read the first string-valued key present, for describe() templates. */
function named(
  input: Record<string, unknown>,
  ...keys: string[]
): string | undefined {
  for (const key of keys) {
    const value = input[key];
    if (typeof value === "string" && value.trim()) return value;
  }
  return undefined;
}

/**
 * THE REGISTRY. Order is the order tools are built and prompt notes are
 * appended, so keep related operations together.
 */
export const AGENT_OP_REGISTRY: readonly AgentOpEntry[] = [
  // ── READ — free, and the difference between an agent that inspects the
  // project and one that guesses at it.
  { operation: listProjectServersOperation, tier: "direct" },
  { operation: listServerToolsOperation, tier: "direct" },
  { operation: listEvalSuitesOperation, tier: "direct" },
  { operation: getEvalSuiteOperation, tier: "direct" },
  { operation: listEvalCasesOperation, tier: "direct" },
  { operation: getEvalCaseOperation, tier: "direct" },
  { operation: listEvalSuiteRunsOperation, tier: "direct" },
  { operation: getEvalRunOperation, tier: "direct" },
  { operation: listEvalRunIterationsOperation, tier: "direct" },
  { operation: getEvalRunStepsOperation, tier: "direct" },
  { operation: listHostsOperation, tier: "direct" },
  { operation: getHostOperation, tier: "direct" },
  { operation: listEnvironmentsOperation, tier: "direct" },

  // ── WRITE — persists, but spends nothing. Every one is picked up by the
  // derived idempotency set below and echoed in the response envelope.
  { operation: createEvalSuiteOperation, tier: "direct" },
  { operation: createEvalCaseOperation, tier: "direct" },
  { operation: updateEvalCaseOperation, tier: "direct" },
  { operation: updateEvalSuiteOperation, tier: "direct" },

  // ── GATED — operations that SPEND (eval quota, org credits).
  //
  // `approvalMode: "auto-deny"` means an unattended turn has no interactive
  // fallback, so the alternative to a proposal is not "ask the user" — it is
  // either spending on the model's own initiative or not offering the action
  // at all. Destructive ops (`delete_*`, `use_sandbox_image`, `reset_computer`)
  // stay excluded entirely: a proposal makes spend deliberate, but it does not
  // make an irreversible deletion recoverable.
  {
    operation: runEvalSuiteOperation,
    tier: "gated",
    proposal: {
      describe: (input) =>
        `Run eval suite ${named(input, "suite", "suiteId") ?? "(unnamed)"}`,
      buttonLabel: "Run it",
      kind: "start",
      resource: evalRunResource,
    },
  },
  {
    operation: runEvalCaseOperation,
    tier: "gated",
    proposal: {
      describe: (input) =>
        `Run eval case ${named(input, "case", "caseId") ?? "(unnamed)"}`,
      buttonLabel: "Run it",
      kind: "start",
      resource: evalRunResource,
    },
  },
  {
    operation: generateEvalCasesOperation,
    tier: "gated",
    proposal: {
      describe: (input) =>
        `Generate eval cases for ${
          named(input, "suite", "suiteId") ?? "(unnamed)"
        }`,
      buttonLabel: "Generate them",
      kind: "generate",
    },
  },
  {
    operation: cancelEvalRunOperation,
    tier: "gated",
    proposal: {
      describe: (input) =>
        `Cancel run ${named(input, "run", "runId") ?? "(unnamed)"}`,
      buttonLabel: "Cancel the run",
      kind: "cancel",
    },
  },
];

const DIRECT_ENTRIES = AGENT_OP_REGISTRY.filter(
  (entry): entry is Extract<AgentOpEntry, { tier: "direct" }> =>
    entry.tier === "direct"
);

const GATED_ENTRIES = AGENT_OP_REGISTRY.filter(
  (entry): entry is Extract<AgentOpEntry, { tier: "gated" }> =>
    entry.tier === "gated"
);

/**
 * The direct tier: reads + writes that persist without spending.
 *
 * Deliberately NOT derived from the in-app `WORKSPACE_OPERATIONS` set (and
 * deliberately not added to it — `isMcpjamToolId` must keep returning false
 * for `create_eval_suite`, or the in-app chat gate widens).
 */
export const AGENT_API_OPERATIONS: ReadonlyArray<AnyPlatformOperation> =
  DIRECT_ENTRIES.map((entry) => entry.operation);

/**
 * The gated tier: the model gets a tool per operation carrying the operation's
 * REAL input schema, but the tool does not execute. It validates, persists a
 * proposal, and returns an action id. A human click is what runs it.
 */
export const AGENT_API_GATED_OPERATIONS: ReadonlyArray<AnyPlatformOperation> =
  GATED_ENTRIES.map((entry) => entry.operation);

/**
 * Operations that PERSIST, derived from each op's own `readOnly` flag.
 *
 * Every one gets a per-call idempotency key derived from the turn key, so a
 * retried turn's writes land on the rows the first attempt created instead of
 * duplicating them. Reads are excluded deliberately: a key on a read is noise
 * on the wire and would be stored on nothing.
 *
 * GATED OPS ARE ABSENT BY CONSTRUCTION, and that is correct — they never
 * execute on this path. Their execution carries its own `proposal:<actionId>`
 * key, minted by the approval route from the action id.
 */
export const WRITE_OPERATION_NAMES: ReadonlySet<string> = new Set(
  DIRECT_ENTRIES.filter((entry) => !entry.operation.readOnly).map(
    (entry) => entry.operation.name
  )
);

const GATED_BY_NAME = new Map(
  GATED_ENTRIES.map((entry) => [entry.operation.name, entry])
);

/** The gated entry for an operation name, or undefined if it is not gated. */
export function gatedEntryFor(
  operationName: string
): Extract<AgentOpEntry, { tier: "gated" }> | undefined {
  return GATED_BY_NAME.get(operationName);
}

/**
 * The proposal metadata a host needs to render an approval control.
 *
 * Falls back to neutral copy for an operation this build does not gate — the
 * caller should have refused already, but a describer is not the place to
 * throw.
 */
export function proposalMetaFor(operationName: string): {
  description: (input: Record<string, unknown>) => string;
  buttonLabel: string;
  kind: ProposedActionKind;
  confirmSeverity?: ProposedActionSeverity;
} {
  const entry = GATED_BY_NAME.get(operationName);
  if (!entry) {
    return {
      description: () => operationName,
      buttonLabel: "Approve",
      kind: "start",
    };
  }
  return {
    description: entry.proposal.describe,
    buttonLabel: entry.proposal.buttonLabel,
    kind: entry.proposal.kind,
    ...(entry.proposal.confirmSeverity
      ? { confirmSeverity: entry.proposal.confirmSeverity }
      : {}),
  };
}

/**
 * Operation-specific prompt guidance, in registry order and de-duplicated.
 *
 * Constant per build — this is what keeps the assembled system prompt a
 * cacheable prefix. A note that varied per request (a project id, a
 * timestamp) would invalidate the cache on every turn.
 */
export const AGENT_OP_PROMPT_NOTES: readonly string[] = (() => {
  const seen = new Set<string>();
  const notes: string[] = [];
  for (const entry of AGENT_OP_REGISTRY) {
    for (const note of entry.promptNotes ?? []) {
      if (seen.has(note)) continue;
      seen.add(note);
      notes.push(note);
    }
  }
  return notes;
})();
