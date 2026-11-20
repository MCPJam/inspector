/**
 * Every tool call the forwarding endpoint passes upstream, and what came back.
 * Recovery reads it before it sends anything again: a call the upstream
 * answered is reconciled from here instead of being repeated, and a call that
 * was forwarded with no answer is uncertain, so the step stops rather than
 * risk running the tool twice.
 */
import { createHash, randomUUID } from "node:crypto";

export type LedgerState = "forwarded" | "result" | "error" | "lost";

export type LedgerEntry = {
  id: string;
  connectorId: string;
  turnId?: string;
  runId?: string;
  jsonrpcId: string | number | null;
  toolName: string;
  toolUseId?: string;
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
  /** ISO timestamp; entries forwarded before it are ignored. */
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
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const keys = Object.keys(value as Record<string, unknown>).sort();
  return `{${keys
    .map(
      (key) =>
        `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`,
    )
    .join(",")}}`;
}

export function hashPayload(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

export function createInMemoryToolCallLedger(): ToolCallLedger {
  const entries = new Map<string, LedgerEntry>();
  return {
    forwarded(entry) {
      const recorded: LedgerEntry = {
        ...entry,
        id: randomUUID(),
        state: "forwarded",
        forwardedAt: new Date().toISOString(),
      };
      entries.set(recorded.id, recorded);
      return recorded;
    },
    settle(id, outcome) {
      const entry = entries.get(id);
      // A settled entry keeps its first outcome: a late duplicate can't rewrite it.
      if (!entry || entry.state !== "forwarded") return;
      entries.set(id, {
        ...entry,
        ...outcome,
        settledAt: new Date().toISOString(),
      });
    },
    forTurn(turnId) {
      return [...entries.values()].filter((entry) => entry.turnId === turnId);
    },
    find(match) {
      return [...entries.values()].filter(
        (entry) =>
          entry.connectorId === match.connectorId &&
          (match.toolUseId === undefined ||
            entry.toolUseId === match.toolUseId) &&
          (match.argsHash === undefined || entry.argsHash === match.argsHash) &&
          (match.toolName === undefined || entry.toolName === match.toolName) &&
          (match.since === undefined || entry.forwardedAt >= match.since),
      );
    },
  };
}

/** The process-wide ledger the endpoint writes and recovery reads. */
export const webClientToolCallLedger: ToolCallLedger =
  createInMemoryToolCallLedger();
