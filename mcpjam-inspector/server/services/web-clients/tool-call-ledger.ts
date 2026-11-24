/**
 * Every tool call the forwarding endpoint passes upstream, and what came back.
 * Recovery reads it before it sends anything again: a call the upstream
 * answered is reconciled from here instead of being repeated, and a call that
 * was forwarded with no answer is uncertain, so the step stops rather than
 * risk running the tool twice.
 */
import { createHash, randomUUID } from "node:crypto";
import { stableStringifyJson } from "@mcpjam/sdk/widget-runtime";

export type LedgerState = "forwarded" | "result" | "error" | "lost";

export type LedgerEntry = {
  id: string;
  connectorId: string;
  turnId?: string;
  runId?: string;
  jsonrpcId: string | number | null;
  toolName: string;
  toolUseId?: string;
  /** The MCPJam user whose OAuth token made the call; a capability connector names none. */
  userId?: string;
  /** SHA-256 of the canonical JSON arguments, never the arguments themselves. */
  argsHash: string;
  state: LedgerState;
  forwardedAt: string;
  settledAt?: string;
  upstreamStatus?: number;
  /** SHA-256 of the result payload, so a reconciled result can be checked. */
  resultHash?: string;
  /** The backend's id for the same call, when it is kept durably. */
  durableId?: string;
};

export type LedgerMatch = {
  connectorId: string;
  toolUseId?: string;
  argsHash?: string;
  toolName?: string;
  /**
   * ISO timestamp; entries forwarded before it are ignored. Compared as a
   * time, so precision and offset don't matter. One that doesn't parse sets
   * no bound: matching too much can only hold a step back, never send a call
   * twice.
   */
  since?: string;
};

export interface ToolCallLedger {
  forwarded(
    entry: Omit<LedgerEntry, "id" | "state" | "forwardedAt" | "settledAt">,
  ): LedgerEntry;
  settle(
    id: string,
    outcome: {
      state: Exclude<LedgerState, "forwarded">;
      upstreamStatus?: number;
      resultHash?: string;
    },
  ): void;
  forTurn(turnId: string): LedgerEntry[];
  find(match: LedgerMatch): LedgerEntry[];
}

/**
 * The backend's copy of the ledger, which outlives this process: recovery
 * after a restart reconciles a lost answer from it. `record` resolves with
 * the durable id, or undefined when this connector's calls are not kept
 * durably, and rejects when the call could not be recorded.
 */
export interface DurableToolCallLedger {
  record(
    entry: Parameters<ToolCallLedger["forwarded"]>[0],
  ): Promise<string | undefined>;
  settle(
    id: string,
    outcome: Parameters<ToolCallLedger["settle"]>[1],
  ): Promise<void>;
}

/** Stable JSON with sorted keys, so equal arguments hash equally. */
export function hashPayload(value: unknown): string {
  // `tools/call` arguments are optional: a call without them hashes as null.
  return createHash("sha256")
    .update(stableStringifyJson(value ?? null))
    .digest("hex");
}

/**
 * How long a call stays here after its answer. Its turn reads it while the
 * turn runs, pauses for a person included, or just after, so a day is far
 * longer than any reader needs.
 */
const SETTLED_RETENTION_MS = 24 * 60 * 60_000;

function addTo(index: Map<string, Set<string>>, key: string, id: string) {
  const ids = index.get(key);
  if (ids) ids.add(id);
  else index.set(key, new Set([id]));
}

function removeFrom(index: Map<string, Set<string>>, key: string, id: string) {
  const ids = index.get(key);
  if (!ids) return;
  ids.delete(id);
  if (ids.size === 0) index.delete(key);
}

/**
 * Calls are kept by turn and by connector, so a read looks only at its own.
 * A call still waiting for its answer is never dropped: it is the one a
 * reconcile must find, because it may have run.
 */
export function createInMemoryToolCallLedger(
  options: { retentionMs?: number } = {},
): ToolCallLedger {
  const retentionMs = options.retentionMs ?? SETTLED_RETENTION_MS;
  const entries = new Map<string, LedgerEntry>();
  const byTurn = new Map<string, Set<string>>();
  const byConnector = new Map<string, Set<string>>();
  // Settled ids in the order they settled, so the oldest are dropped first.
  const settledAtMs = new Map<string, number>();
  const pick = (ids: Set<string> | undefined) =>
    [...(ids ?? [])].flatMap((id) => entries.get(id) ?? []);
  const prune = () => {
    const cutoff = Date.now() - retentionMs;
    for (const [id, at] of settledAtMs) {
      if (at > cutoff) break;
      settledAtMs.delete(id);
      const entry = entries.get(id);
      if (!entry) continue;
      entries.delete(id);
      removeFrom(byConnector, entry.connectorId, id);
      if (entry.turnId !== undefined) removeFrom(byTurn, entry.turnId, id);
    }
  };
  return {
    forwarded(entry) {
      prune();
      const recorded: LedgerEntry = {
        ...entry,
        id: randomUUID(),
        state: "forwarded",
        forwardedAt: new Date().toISOString(),
      };
      entries.set(recorded.id, recorded);
      addTo(byConnector, recorded.connectorId, recorded.id);
      if (recorded.turnId !== undefined)
        addTo(byTurn, recorded.turnId, recorded.id);
      return recorded;
    },
    settle(id, outcome) {
      const entry = entries.get(id);
      // A settled entry keeps its first outcome: a late duplicate can't rewrite it.
      if (!entry || entry.state !== "forwarded") return;
      const now = new Date();
      entries.set(id, {
        ...entry,
        ...outcome,
        settledAt: now.toISOString(),
      });
      settledAtMs.set(id, now.getTime());
      prune();
    },
    forTurn(turnId) {
      return pick(byTurn.get(turnId));
    },
    find(match) {
      const since =
        match.since === undefined ? Number.NaN : Date.parse(match.since);
      return pick(byConnector.get(match.connectorId)).filter(
        (entry) =>
          (match.toolUseId === undefined ||
            entry.toolUseId === match.toolUseId) &&
          (match.argsHash === undefined || entry.argsHash === match.argsHash) &&
          (match.toolName === undefined || entry.toolName === match.toolName) &&
          (Number.isNaN(since) || Date.parse(entry.forwardedAt) >= since),
      );
    },
  };
}

/** The process-wide ledger the endpoint writes and recovery reads. */
export const webClientToolCallLedger: ToolCallLedger =
  createInMemoryToolCallLedger();
