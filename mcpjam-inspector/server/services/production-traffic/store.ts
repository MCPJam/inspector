/**
 * What the production traffic receiver writes and the read routes ask, behind
 * one interface. `clickhouse-store.ts` is the only implementation, and the
 * only code that builds SQL: every read takes the project as a bound
 * parameter, so a caller cannot widen a query beyond the project it was
 * authorized for.
 */

/** Rules version 1 (engineering spec E9), reported with every read. */
export const TRAFFIC_RULES_VERSION = 1;

/** JSON-RPC codes OpenTelemetry says not to count as errors: a request the
 * server refused rather than failed on. */
export const REJECTED_REQUEST_CODES = [
  "-32700",
  "-32600",
  "-32601",
  "-32602",
  "-32002",
] as const;

/** A stable 5% of calls, chosen by span id, so the sample needs no state. */
export const RANDOM_SAMPLE_PER_MILLE = 50;

export type ReviewReason =
  | "protocol_error"
  | "rejected_request"
  | "tool_error"
  | "outcome_not_met"
  | "random_sample";

export type CallRow = {
  traceId: string;
  spanId: string;
  parentSpanId: string;
  startTimeUnixNano: bigint;
  endTimeUnixNano: bigint;
  serviceName: string;
  serviceVersion: string;
  deploymentEnvironment: string;
  toolName: string;
  clientName: string;
  clientVersion: string;
  protocolVersion: string;
  jsonrpcRequestId: string;
  conversationId: string;
  errorType: string;
  rpcStatusCode: string;
  spanStatusCode: number;
  /** Present only when the project stores content; null otherwise. */
  arguments: string | null;
  result: string | null;
};

export type OutcomeRow = {
  callTraceId: string;
  callSpanId: string;
  outcomeName: string;
  outcomeStatus: "met" | "not_met";
  outcomeEndTimeUnixNano: bigint;
  outcomeTraceId: string;
  outcomeSpanId: string;
};

export type DropRow = {
  reason: string;
  count: number;
  /** Digest of the decoded request, so a replayed batch is counted once. */
  batchDigest: string;
  /** UTC day, `YYYY-MM-DD`. */
  day: string;
};

export type TrafficBatch = {
  calls: CallRow[];
  outcomes: OutcomeRow[];
  drops: DropRow[];
};

export type TrafficWindow = {
  fromMs: number;
  toMs: number;
  /** Narrows reads to one `service.name`, e.g. a smoke run's own server. */
  serviceName?: string;
};

export type TrafficCounts = {
  rulesVersion: number;
  received: number;
  evaluated: number;
  unmeasured: number;
  flagged: Record<ReviewReason, number>;
  dropped: Record<string, number>;
};

export type ListedCall = {
  /** Opaque source reference: `<traceId>:<spanId>`. */
  ref: string;
  startTime: string;
  durationMs: number;
  serviceName: string;
  serviceVersion: string;
  toolName: string;
  clientName: string;
  clientVersion: string;
  errorType: string | null;
  jsonrpcCode: string | null;
  outcomes: { name: string; status: "met" | "not_met" }[];
  reasons: ReviewReason[];
};

export type CallListQuery = TrafficWindow & {
  reason?: ReviewReason;
  limit: number;
};

export interface ProductionTrafficStore {
  /** Resolves only once every row is durably written. */
  record(projectId: string, batch: TrafficBatch): Promise<void>;
  counts(projectId: string, window: TrafficWindow): Promise<TrafficCounts>;
  listCalls(projectId: string, query: CallListQuery): Promise<ListedCall[]>;
  close(): Promise<void>;
}

/** A store that cannot serve right now; the receiver answers 503. */
export class TrafficStoreUnavailableError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "TrafficStoreUnavailableError";
  }
}
