/**
 * Reconciling what the harness SAID it did with what the proxy SAW it do.
 *
 * A harness turn produces two independent records. The NARRATION is Claude
 * Code's own event stream: it drives the conversation, and it is the only
 * record of the model's intent — but it can flatten a result, drop a call it
 * made, or describe one it did not. The EVIDENCE is the proxy's: one settled
 * row per `tools/call` that actually crossed the wire, carrying the arguments
 * the server received and the raw result it returned. Neither is a superset of
 * the other, and this module is where they are put side by side without either
 * being allowed to overwrite the other.
 *
 * ## The two transcripts, and why they must not be one
 *
 * `modelMessages` — the narration, unchanged. It is what the harness
 * conversation continues from, so it may never receive content the harness did
 * not narrate: a synthetic message here would put words in the model's history
 * that it never saw, and every subsequent turn would be reasoning from a
 * transcript that never existed.
 *
 * `traceMessages` — the evidence-enriched projection, for persistence, run
 * detail, evidence-graded predicates and widget hydration. Matched calls keep
 * their narrated output and GAIN the raw result; wire-only calls are added,
 * marked as reconstructed.
 *
 * Nothing downstream may call either of them `messages`. The whole failure
 * mode this program is fixing is a transcript whose provenance nobody could
 * name.
 *
 * ## Matching, and the ambiguity rule
 *
 * A narrated call matches an evidence row on `(serverId, toolName,
 * canonicalDigest(arguments))`, then by ordinal within that tuple: the first
 * narrated `search{q:"x"}` matches the first wire `search{q:"x"}`, and so on.
 * Strict, with no looser fallback — a "close enough" tier would pair a
 * possibly-hallucinated narration with a possibly-dropped wire call, and
 * attaching one call's result to another is worse than attaching none.
 *
 * ## Completeness, and why zero rows is not automatically complete
 *
 * "Every row settled" is vacuously true of no rows. A turn that narrated tool
 * calls and produced no evidence at all is the signature of capture that never
 * armed — a claimless token, an unconfigured transport, a version skew — and
 * treating it as complete would flip every narrated call to "hallucinated" on
 * a run where the recorder, not the model, was at fault. So a turn is complete
 * only if it also has no unexplained silence.
 */
import { canonicalDigest } from "@mcpjam/sdk/contract";
import { isCallToolResultError } from "@mcpjam/sdk";
import {
  buildMcpToolErrorResultMessage,
  buildMcpToolResultMessage,
  jsonRpcErrorMessageText,
  mcpToolErrorOutput,
} from "@/shared/mcp-tool-result-message";

/** One settled proxy row, as the read route returns it. */
export type EvidenceRow = {
  requestId: string;
  turnId: string;
  serverId: string;
  toolName: string;
  argumentsJson: string | null;
  /**
   * Where a spilled arguments payload can be fetched, when it did not travel
   * inline. Resolved by the reader before the merge ever sees the row.
   */
  argumentsUrl?: string | null;
  status: "started" | "settled";
  outcomeKind: "success" | "call_tool_error" | "jsonrpc_error" | null;
  responseJson: string | null;
  responseUrl?: string | null;
  startedAtMs: number;
  settledAtMs: number | null;
  payloadsReadable: boolean;
};

/** A tool call as the harness narrated it. */
export type NarratedToolCall = {
  toolCallId: string;
  toolName: string;
  serverId?: string;
  /**
   * The narrated name is MCP-SHAPED (`mcp__…`) but no span survived to
   * resolve its serverId. Matching stays strict — without a serverId there is
   * no identity to match on — but the completeness zero-row guard counts it
   * as an MCP call, because "the span was lost" must not read as "this was a
   * native tool" and let a captureless turn grade as complete.
   */
  mcpShaped?: boolean;
  arguments: unknown;
  /** Narrated model-visible output, if the harness reported one. */
  output?: unknown;
  /** Excluded from evidence reconciliation — it never reached a server. */
  policyBlocked?: boolean;
};

/**
 * One call, as it actually happened: a settled row parsed into usable shape.
 * Internal to the merge — `actualToolCalls` keeps its public
 * `{toolName, arguments, toolCallId?}` shape.
 */
export type CanonicalMcpCall = {
  requestId: string;
  serverId: string;
  toolName: string;
  arguments: Record<string, unknown>;
  response: unknown;
  outcomeKind: "success" | "call_tool_error" | "jsonrpc_error";
  startedAtMs: number;
  settledAtMs: number;
};

export type EvidenceCompleteness =
  | { status: "complete" }
  | { status: "incomplete"; reason: EvidenceIncompleteReason };

export type EvidenceIncompleteReason =
  /** A row started and never settled — the durable marker of a lost tail. */
  | "unsettled_row"
  /** A settled row whose payload could not be read back. */
  | "unreadable_payload"
  /** Pagination did not finish, so the row set is not known to be whole. */
  | "read_incomplete"
  /**
   * The read returned rows this build could not parse — version skew on a
   * backend-deploys-first topology. The set is known to have holes even
   * though pagination finished.
   */
  | "unparseable_row"
  /** Narrated MCP calls with no evidence at all — capture never armed. */
  | "no_evidence_for_narrated_calls"
  /** A call refused because its start could not be recorded. */
  | "evidence_unavailable_marker";

export type MergeInput = {
  rows: EvidenceRow[];
  /** Whether the paginated read reached the end. */
  readExhausted: boolean;
  /** Rows the reader received but could not parse. >0 ⇒ incomplete. */
  unparseableRows?: number;
  narratedCalls: NarratedToolCall[];
  /**
   * Whether any narrated tool result carries the proxy's
   * evidence-unavailable refusal. A refused call left NO row, so it is
   * invisible to the row set — the narration is the only place it exists.
   */
  sawEvidenceUnavailableMarker?: boolean;
};

export type MergeResult = {
  completeness: EvidenceCompleteness;
  /** Settled rows, parsed. Empty when the turn is incomplete for a read reason. */
  canonicalCalls: CanonicalMcpCall[];
  /** Narrated call → the evidence row it matched, by `toolCallId`. */
  matchedByToolCallId: Map<string, CanonicalMcpCall>;
  /** Evidence rows no narrated call claimed, in wire order. */
  wireOnlyCalls: CanonicalMcpCall[];
  /** Narrated calls with no matching row, by `toolCallId`. */
  narrationOnlyToolCallIds: Set<string>;
};

/**
 * The identity a narrated call and a wire row must share to be the same call.
 *
 * `canonicalDigest` (RFC 8785-style canonical JSON) rather than
 * `JSON.stringify`: the harness serializes its arguments and the proxy
 * re-serializes what it received, so key ORDER is not stable between them
 * while the value is. A digest that cared about order would report every call
 * as unmatched.
 *
 * The separator is NUL because a tool name may contain any printable
 * character, and a separator a name could contain lets two different calls
 * collide on one key. Written as an escape, never as a literal control byte:
 * a raw NUL in the source makes git treat the whole file as binary, and a
 * module nobody can read the diff of is its own kind of hazard.
 */
function callIdentity(
  serverId: string | undefined,
  toolName: string,
  args: unknown,
): string {
  const digest = canonicalDigest(
    args && typeof args === "object" ? args : ((args ?? {}) as never),
  );
  return `${serverId ?? ""}\u0000${toolName}\u0000${digest}`;
}

function parseJson(value: string | null): unknown {
  if (value === null) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

/**
 * Parse a settled row into a canonical call, or `null` if it is not one.
 *
 * A row that is unsettled or unreadable is NOT downgraded into a partial call:
 * the turn's completeness check has already recorded why, and a half-populated
 * call would let a grader read a value that was never really there.
 */
function toCanonicalCall(row: EvidenceRow): CanonicalMcpCall | null {
  if (row.status !== "settled" || !row.payloadsReadable) return null;
  if (row.settledAtMs === null || row.outcomeKind === null) return null;
  const args = parseJson(row.argumentsJson);
  return {
    requestId: row.requestId,
    serverId: row.serverId,
    toolName: row.toolName,
    arguments:
      args && typeof args === "object" && !Array.isArray(args)
        ? (args as Record<string, unknown>)
        : {},
    response: parseJson(row.responseJson),
    outcomeKind: row.outcomeKind,
    startedAtMs: row.startedAtMs,
    settledAtMs: row.settledAtMs,
  };
}

/**
 * Is this turn's evidence whole?
 *
 * Every arm answers the same question — "could a call have happened that this
 * record does not show?" — and any yes makes the turn incomplete, which routes
 * its grading back to narration rather than scoring against a partial record.
 */
export function assessCompleteness(input: MergeInput): EvidenceCompleteness {
  if (input.sawEvidenceUnavailableMarker) {
    return { status: "incomplete", reason: "evidence_unavailable_marker" };
  }
  if (!input.readExhausted) {
    return { status: "incomplete", reason: "read_incomplete" };
  }
  if ((input.unparseableRows ?? 0) > 0) {
    // The reader saw rows it could not understand. Pagination may well have
    // finished, but a set with known holes graded as complete would stamp
    // the very calls those rows recorded as `wireCorroborated: false` — the
    // persisted trace accusing the model of hallucinating calls the proxy
    // in fact captured.
    return { status: "incomplete", reason: "unparseable_row" };
  }
  for (const row of input.rows) {
    if (row.status !== "settled") {
      return { status: "incomplete", reason: "unsettled_row" };
    }
    if (!row.payloadsReadable) {
      return { status: "incomplete", reason: "unreadable_payload" };
    }
  }
  if (input.rows.length === 0) {
    // Policy-blocked calls are excluded on purpose: they are refused before
    // the bridge, so they legitimately produce no row. A turn whose only
    // calls were blocked is complete, and counting them here would downgrade
    // every policy-exercising turn to narration grading.
    const narratedMcpCalls = input.narratedCalls.filter(
      (call) => !call.policyBlocked && (call.serverId || call.mcpShaped),
    );
    if (narratedMcpCalls.length > 0) {
      return {
        status: "incomplete",
        reason: "no_evidence_for_narrated_calls",
      };
    }
  }
  return { status: "complete" };
}

/**
 * Reconcile narration against evidence.
 *
 * Ordering is deliberate on both sides: narrated calls keep the order the
 * model made them, and wire-only calls are ordered by `(startedAtMs,
 * requestId)` — the request id breaking ties so two calls started in the same
 * millisecond get a stable order rather than an arbitrary one. The merger
 * never INVENTS an order it cannot observe.
 */
export function mergeHarnessEvidence(input: MergeInput): MergeResult {
  const completeness = assessCompleteness(input);

  const canonicalCalls = input.rows
    .map(toCanonicalCall)
    .filter((call): call is CanonicalMcpCall => call !== null)
    .sort(
      (a, b) =>
        a.startedAtMs - b.startedAtMs || a.requestId.localeCompare(b.requestId),
    );

  // Bucket the wire calls by identity, so each narrated call takes the NEXT
  // unclaimed row of its tuple. Ordinal matching within a tuple is what makes
  // three identical calls three calls rather than one.
  const unclaimed = new Map<string, CanonicalMcpCall[]>();
  for (const call of canonicalCalls) {
    const key = callIdentity(call.serverId, call.toolName, call.arguments);
    const bucket = unclaimed.get(key);
    if (bucket) bucket.push(call);
    else unclaimed.set(key, [call]);
  }

  const matchedByToolCallId = new Map<string, CanonicalMcpCall>();
  const narrationOnlyToolCallIds = new Set<string>();
  const claimed = new Set<string>();

  for (const narrated of input.narratedCalls) {
    // A blocked call never reached a server, so it has no wire counterpart to
    // find and is not evidence of anything missing.
    if (narrated.policyBlocked) continue;
    const key = callIdentity(
      narrated.serverId,
      narrated.toolName,
      narrated.arguments,
    );
    const bucket = unclaimed.get(key);
    const match = bucket?.shift();
    if (match) {
      matchedByToolCallId.set(narrated.toolCallId, match);
      claimed.add(match.requestId);
    } else if (narrated.serverId) {
      // MCP calls only. A native harness tool (Bash, Read) never crosses the
      // proxy, so its absence from the evidence says nothing.
      narrationOnlyToolCallIds.add(narrated.toolCallId);
    }
  }

  const wireOnlyCalls = canonicalCalls.filter(
    (call) => !claimed.has(call.requestId),
  );

  return {
    completeness,
    canonicalCalls,
    matchedByToolCallId,
    wireOnlyCalls,
    narrationOnlyToolCallIds,
  };
}

/**
 * The `toolCallId` a wire-only call is given in the trace transcript.
 *
 * Prefixed and derived from the request id so it is stable across re-reads and
 * obviously not a harness-minted id — a reader (or a test) can tell at a glance
 * that this part came from the wire, not the narration.
 */
export function evidenceToolCallId(requestId: string): string {
  return `evidence:${requestId}`;
}

/**
 * Project one canonical call into the tool-result message shape the emulated
 * engine produces, through the SAME builder.
 *
 * `output` is reconstructed from the raw result rather than narrated, because
 * for a wire-only call there is no narration to take it from — that is exactly
 * what makes the call wire-only. The span carries `outputSource:
 * "reconstructed"` so nothing downstream mistakes it for what the model saw.
 */
export function buildEvidenceToolResultMessage(call: CanonicalMcpCall) {
  if (call.outcomeKind === "jsonrpc_error") {
    return buildMcpToolErrorResultMessage({
      toolCallId: evidenceToolCallId(call.requestId),
      toolName: call.toolName,
      output: mcpToolErrorOutput(jsonRpcErrorMessageText(call.response)),
    });
  }
  return buildMcpToolResultMessage({
    toolCallId: evidenceToolCallId(call.requestId),
    toolName: call.toolName,
    serverId: call.serverId,
    // The raw result IS the model-visible projection here. A richer projection
    // (the SDK's linked-resource reader) needs a live client the merge does not
    // have, and inventing one would be a paraphrase presented as a record.
    output: { type: "json", value: call.response } as never,
    rawResult: call.response,
    includeRawResult: true,
  });
}

/**
 * Classify a settled response the way the outcome kinds do, from the response
 * itself — used to check a row's recorded `outcomeKind` against its payload.
 *
 * A disagreement means the row was written by a version that classified
 * differently, and the PAYLOAD wins: it is the thing the server actually
 * returned.
 */
export function classifyEvidenceResponse(
  response: unknown,
  recorded: CanonicalMcpCall["outcomeKind"],
): CanonicalMcpCall["outcomeKind"] {
  if (recorded === "jsonrpc_error") return "jsonrpc_error";
  return isCallToolResultError(response) ? "call_tool_error" : "success";
}
