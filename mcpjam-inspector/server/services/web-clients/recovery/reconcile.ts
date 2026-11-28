/**
 * Before a step is sent again, after a restart or a lost reply, the ledger
 * says whether its tool calls already reached the upstream server. Resending a
 * prompt makes the vendor's model call its tools again. When the upstream
 * answered every call, the vendor's model has the results and the step's
 * reply is read from the vendor's conversation instead. A call forwarded with
 * no answer may have run: the step stops and says so rather than risk running
 * the tool twice.
 */
import type { LedgerEntry, LedgerMatch } from "../tool-call-ledger.js";
import type { PendingStep } from "./backend.js";

/** The ledger's read side. The durable ledger answers asynchronously. */
export type LedgerReader = {
  find(match: LedgerMatch): LedgerEntry[] | Promise<LedgerEntry[]>;
  forTurn(turnId: string): LedgerEntry[] | Promise<LedgerEntry[]>;
};

export type ReconcileInput = {
  runId: string;
  /**
   * Every connector the run's tool calls go through. Without them, only the
   * step's own turn is read, which is exact when the step has a turn id.
   */
  connectorIds?: readonly string[];
  step: PendingStep;
  /** Narrows the check to one call, when the runtime saw the vendor's tool use. */
  toolUseId?: string;
  argsHash?: string;
};

export type ReconcileOutcome =
  /** No call reached the upstream since the step started, so sending is safe. */
  | { status: "send" }
  /**
   * The upstream answered every call, so the step is not sent again: its
   * reply is read from the vendor's conversation. The ledger keeps only a
   * hash of each result, so these records say only that the calls were
   * answered.
   */
  | { status: "reconciled"; calls: LedgerEntry[] }
  /** These calls were forwarded and never answered. They may have run. */
  | { status: "ambiguous_execution"; calls: LedgerEntry[] };

/** A gateway's error says nothing about whether the server ran the tool. */
const GATEWAY_STATUSES = new Set([502, 504]);

function upstreamAnswered(entry: LedgerEntry): boolean {
  if (entry.state === "result") return true;
  return (
    entry.state === "error" &&
    entry.upstreamStatus !== undefined &&
    !GATEWAY_STATUSES.has(entry.upstreamStatus)
  );
}

/**
 * The reads share no snapshot, so a call that settles between them comes
 * back answered from one and still forwarded from the other. A call settles
 * once, so the answered row is the newer one, whichever read it came from.
 */
function dedupeKeepingAnswered(entries: LedgerEntry[]): LedgerEntry[] {
  const byId = new Map<string, LedgerEntry>();
  for (const entry of entries) {
    const seen = byId.get(entry.id);
    if (!seen || (!upstreamAnswered(seen) && upstreamAnswered(entry))) {
      byId.set(entry.id, entry);
    }
  }
  return [...byId.values()];
}

export async function reconcileWithLedger(
  ledger: LedgerReader,
  input: ReconcileInput,
): Promise<ReconcileOutcome> {
  const { runId, step, toolUseId, argsHash, connectorIds } = input;
  // With no turn and no connector to read, nothing rules out a forwarded call.
  if (!step.turnId && !connectorIds?.length) {
    throw new Error(
      "A step with no turn and no connectors can't be checked against the ledger.",
    );
  }
  const belongsToStep = (entry: LedgerEntry) =>
    (connectorIds === undefined || connectorIds.includes(entry.connectorId)) &&
    (toolUseId === undefined || entry.toolUseId === toolUseId) &&
    (argsHash === undefined || entry.argsHash === argsHash) &&
    // Runs on one account share its connectors. A call with no run might be ours.
    (entry.runId === undefined || entry.runId === runId);
  const found = await Promise.all([
    ...(connectorIds ?? []).map((connectorId) =>
      ledger.find({ connectorId, since: step.startedAt, toolUseId, argsHash }),
    ),
    // The step's own turn too, so clock skew between replicas can't hide a call.
    ...(step.turnId ? [ledger.forTurn(step.turnId)] : []),
  ]);
  const calls = dedupeKeepingAnswered(found.flat().filter(belongsToStep));
  if (calls.length === 0) return { status: "send" };
  const unanswered = calls.filter((entry) => !upstreamAnswered(entry));
  if (unanswered.length > 0) {
    return { status: "ambiguous_execution", calls: unanswered };
  }
  return { status: "reconciled", calls };
}
