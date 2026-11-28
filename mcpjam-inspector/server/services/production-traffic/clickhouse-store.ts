/**
 * The ClickHouse implementation of `ProductionTrafficStore`.
 *
 * Writes are synchronous inserts, so a batch is acknowledged only after
 * ClickHouse has the rows. Duplicates are resolved by the table engines
 * (see `clickhouse-schema.ts`) and reads use FINAL. Flags, the random sample
 * and counts are computed here at read time from the stored rows, under
 * rules version 1, so a rule change never rewrites history.
 */
import {
  ClickHouseLogLevel,
  createClient,
  type ClickHouseClient,
} from "@clickhouse/client";
import {
  readClickHouseConnection,
  type ClickHouseConnection,
} from "./clickhouse-config.js";
import {
  PRODUCTION_TRAFFIC_SCHEMA_VERSION,
  readSchemaVersion,
  SOURCE_RETENTION_DAYS,
} from "./clickhouse-schema.js";
import {
  RANDOM_SAMPLE_PER_MILLE,
  REJECTED_REQUEST_CODES,
  TRAFFIC_RULES_VERSION,
  TrafficStoreUnavailableError,
  type CallListQuery,
  type ListedCall,
  type ProductionTrafficStore,
  type ReviewReason,
  type TrafficBatch,
  type TrafficCounts,
  type TrafficWindow,
} from "./store.js";

export function createTrafficClickHouseClient(
  connection: ClickHouseConnection,
): ClickHouseClient {
  return createClient({
    url: connection.url,
    username: connection.username,
    password: connection.password,
    database: connection.database,
    application: "mcpjam-production-traffic",
    request_timeout: 10_000,
    max_open_connections: 8,
    // The client logs failed queries to the console itself; this store
    // reports its failures through the server logger instead.
    log: { level: ClickHouseLogLevel.OFF },
    ...(connection.caCert ? { tls: { ca_cert: connection.caCert } } : {}),
  });
}

/** ClickHouse's text form of a DateTime64(9) in UTC, exact to the nanosecond. */
export function toDateTime64(unixNano: bigint): string {
  const seconds = unixNano / 1_000_000_000n;
  const fraction = (unixNano % 1_000_000_000n).toString().padStart(9, "0");
  const whole = new Date(Number(seconds) * 1000).toISOString().slice(0, 19);
  return `${whole.replace("T", " ")}.${fraction}`;
}

const REASON_COLUMNS: Record<ReviewReason, string> = {
  protocol_error: "is_protocol_error",
  rejected_request: "is_rejected_request",
  tool_error: "is_tool_error",
  outcome_not_met: "not_met",
  random_sample: "is_sampled",
};

// Production calls in the window, each with its latest outcome per outcome
// name and its review flags. Only production traffic is counted or flagged:
// test copies report another `deployment.environment.name`.
const FLAGGED_CALLS = `
calls AS (
  SELECT trace_id, span_id, start_time, end_time, service_name,
    service_version, tool_name, client_name, client_version, error_type,
    if(match(error_type, '^-?[0-9]+$'), error_type, rpc_status_code) AS jsonrpc_code
  FROM mcp_tool_calls FINAL
  WHERE project_id = {projectId:String}
    AND deployment_environment = 'production'
    AND start_time >= fromUnixTimestamp64Milli({fromMs:Int64}, 'UTC')
    AND start_time < fromUnixTimestamp64Milli({toMs:Int64}, 'UTC')
    AND start_time >= now64(3) - INTERVAL ${SOURCE_RETENTION_DAYS} DAY
    AND ({serviceName:String} = '' OR service_name = {serviceName:String})
),
latest_outcomes AS (
  SELECT call_trace_id, call_span_id, outcome_name,
    argMax(outcome_status, (outcome_end_time, outcome_span_id)) AS status
  FROM mcp_call_outcomes
  WHERE project_id = {projectId:String}
    AND outcome_end_time >= now64(3) - INTERVAL ${SOURCE_RETENTION_DAYS} DAY
    AND (call_trace_id, call_span_id) IN (SELECT trace_id, span_id FROM calls)
  GROUP BY call_trace_id, call_span_id, outcome_name
),
per_call AS (
  SELECT call_trace_id, call_span_id,
    arraySort(groupArray((outcome_name, status))) AS outcomes,
    countIf(status = 'not_met') > 0 AS not_met
  FROM latest_outcomes
  GROUP BY call_trace_id, call_span_id
),
flagged AS (
  SELECT calls.trace_id AS trace_id, calls.span_id AS span_id,
    calls.start_time AS start_time,
    toUnixTimestamp64Nano(calls.end_time) - toUnixTimestamp64Nano(calls.start_time) AS duration_ns,
    service_name, service_version, tool_name, client_name, client_version,
    error_type, jsonrpc_code, per_call.outcomes AS outcomes,
    notEmpty(per_call.outcomes) AS evaluated,
    per_call.not_met AS not_met,
    jsonrpc_code != '' AND NOT has({rejected:Array(String)}, jsonrpc_code) AS is_protocol_error,
    has({rejected:Array(String)}, jsonrpc_code) AS is_rejected_request,
    error_type = 'tool_error' AS is_tool_error,
    cityHash64(calls.span_id) % 1000 < {samplePerMille:UInt32} AS is_sampled
  FROM calls
  LEFT JOIN per_call
    ON calls.trace_id = per_call.call_trace_id
    AND calls.span_id = per_call.call_span_id
)`;

type CountsRow = Record<string, string | number>;
type CallRowOut = {
  trace_id: string;
  span_id: string;
  started_at: string;
  duration_ns: string | number;
  service_name: string;
  service_version: string;
  tool_name: string;
  client_name: string;
  client_version: string;
  error_type: string;
  jsonrpc_code: string;
  outcomes: [string, "met" | "not_met"][];
} & Record<string, unknown>;

const asBool = (value: unknown) => Boolean(Number(value));
const toIso = (value: string) => `${value.replace(" ", "T")}Z`;

export class ClickHouseTrafficStore implements ProductionTrafficStore {
  private schemaChecked = false;

  constructor(private readonly client: ClickHouseClient) {}

  /** Refuses to serve until the schema is at the version this code expects. */
  private async ready(): Promise<void> {
    if (this.schemaChecked) return;
    const version = await this.guard(() => readSchemaVersion(this.client));
    if (version < PRODUCTION_TRAFFIC_SCHEMA_VERSION) {
      throw new TrafficStoreUnavailableError(
        `Production traffic storage is at schema version ${version}. Run the production traffic migration to reach version ${PRODUCTION_TRAFFIC_SCHEMA_VERSION}.`,
      );
    }
    this.schemaChecked = true;
  }

  private async guard<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (error) {
      if (error instanceof TrafficStoreUnavailableError) throw error;
      throw new TrafficStoreUnavailableError(
        "Production traffic storage did not answer",
        { cause: error },
      );
    }
  }

  private params(projectId: string, window: TrafficWindow) {
    return {
      projectId,
      fromMs: window.fromMs,
      toMs: window.toMs,
      serviceName: window.serviceName ?? "",
      rejected: [...REJECTED_REQUEST_CODES],
      samplePerMille: RANDOM_SAMPLE_PER_MILLE,
    };
  }

  async record(projectId: string, batch: TrafficBatch): Promise<void> {
    await this.ready();
    await this.guard(async () => {
      if (batch.calls.length > 0) {
        await this.client.insert({
          table: "mcp_tool_calls",
          format: "JSONEachRow",
          values: batch.calls.map((call) => ({
            project_id: projectId,
            trace_id: call.traceId,
            span_id: call.spanId,
            parent_span_id: call.parentSpanId,
            start_time: toDateTime64(call.startTimeUnixNano),
            end_time: toDateTime64(call.endTimeUnixNano),
            service_name: call.serviceName,
            service_version: call.serviceVersion,
            deployment_environment: call.deploymentEnvironment,
            tool_name: call.toolName,
            client_name: call.clientName,
            client_version: call.clientVersion,
            protocol_version: call.protocolVersion,
            jsonrpc_request_id: call.jsonrpcRequestId,
            conversation_id: call.conversationId,
            error_type: call.errorType,
            rpc_status_code: call.rpcStatusCode,
            span_status_code: call.spanStatusCode,
            arguments: call.arguments,
            result: call.result,
          })),
        });
      }
      if (batch.outcomes.length > 0) {
        await this.client.insert({
          table: "mcp_call_outcomes",
          format: "JSONEachRow",
          values: batch.outcomes.map((outcome) => ({
            project_id: projectId,
            call_trace_id: outcome.callTraceId,
            call_span_id: outcome.callSpanId,
            outcome_name: outcome.outcomeName,
            outcome_status: outcome.outcomeStatus,
            outcome_end_time: toDateTime64(outcome.outcomeEndTimeUnixNano),
            outcome_trace_id: outcome.outcomeTraceId,
            outcome_span_id: outcome.outcomeSpanId,
          })),
        });
      }
      if (batch.drops.length > 0) {
        await this.client.insert({
          table: "mcp_ingest_drops",
          format: "JSONEachRow",
          values: batch.drops.map((drop) => ({
            project_id: projectId,
            day: drop.day,
            reason: drop.reason,
            batch_digest: drop.batchDigest,
            dropped: drop.count,
          })),
        });
      }
    });
  }

  async counts(
    projectId: string,
    window: TrafficWindow,
  ): Promise<TrafficCounts> {
    await this.ready();
    const params = this.params(projectId, window);
    const [totals, drops] = await this.guard(async () => {
      const totalsResult = await this.client.query({
        query: `WITH ${FLAGGED_CALLS}
          SELECT count() AS received, countIf(evaluated) AS evaluated,
            countIf(is_protocol_error) AS protocol_error,
            countIf(is_rejected_request) AS rejected_request,
            countIf(is_tool_error) AS tool_error,
            countIf(not_met) AS outcome_not_met,
            countIf(is_sampled) AS random_sample
          FROM flagged`,
        query_params: params,
        format: "JSONEachRow",
      });
      const dropsResult = await this.client.query({
        query: `SELECT reason, sum(dropped) AS dropped
          FROM mcp_ingest_drops FINAL
          WHERE project_id = {projectId:String}
            AND day >= toDate(fromUnixTimestamp64Milli({fromMs:Int64}, 'UTC'))
            AND day <= toDate(fromUnixTimestamp64Milli({toMs:Int64}, 'UTC'))
          GROUP BY reason`,
        query_params: params,
        format: "JSONEachRow",
      });
      return [
        (await totalsResult.json<CountsRow>())[0] ?? {},
        await dropsResult.json<{ reason: string; dropped: string | number }>(),
      ] as const;
    });
    const received = Number(totals.received ?? 0);
    const evaluated = Number(totals.evaluated ?? 0);
    const flagged = Object.fromEntries(
      (Object.keys(REASON_COLUMNS) as ReviewReason[]).map((reason) => [
        reason,
        Number(totals[reason] ?? 0),
      ]),
    ) as Record<ReviewReason, number>;
    return {
      rulesVersion: TRAFFIC_RULES_VERSION,
      received,
      evaluated,
      unmeasured: received - evaluated,
      flagged,
      dropped: Object.fromEntries(
        drops.map((row) => [row.reason, Number(row.dropped)]),
      ),
    };
  }

  async listCalls(
    projectId: string,
    query: CallListQuery,
  ): Promise<ListedCall[]> {
    await this.ready();
    const reasonFilter = query.reason
      ? `WHERE ${REASON_COLUMNS[query.reason]}`
      : "";
    const rows = await this.guard(async () => {
      const result = await this.client.query({
        query: `WITH ${FLAGGED_CALLS}
          SELECT trace_id, span_id, toString(start_time) AS started_at,
            duration_ns,
            service_name, service_version, tool_name, client_name,
            client_version, error_type, jsonrpc_code, outcomes,
            is_protocol_error, is_rejected_request, is_tool_error, not_met,
            is_sampled
          FROM flagged
          ${reasonFilter}
          ORDER BY start_time DESC, span_id DESC
          LIMIT {limit:UInt32}`,
        query_params: { ...this.params(projectId, query), limit: query.limit },
        format: "JSONEachRow",
      });
      return await result.json<CallRowOut>();
    });
    return rows.map((row) => ({
      ref: `${row.trace_id}:${row.span_id}`,
      startTime: toIso(row.started_at),
      durationMs: Number(row.duration_ns) / 1e6,
      serviceName: row.service_name,
      serviceVersion: row.service_version,
      toolName: row.tool_name,
      clientName: row.client_name,
      clientVersion: row.client_version,
      errorType: row.error_type || null,
      jsonrpcCode: row.jsonrpc_code || null,
      outcomes: row.outcomes.map(([name, status]) => ({ name, status })),
      reasons: (Object.keys(REASON_COLUMNS) as ReviewReason[]).filter(
        (reason) => asBool(row[REASON_COLUMNS[reason]]),
      ),
    }));
  }

  async close(): Promise<void> {
    await this.client.close();
  }
}

let shared: ProductionTrafficStore | null | undefined;

/**
 * This process's store, or null when the deployment has no production traffic
 * database. Throws on a half-configured deployment, naming the missing
 * variable.
 */
export function getProductionTrafficStore(): ProductionTrafficStore | null {
  if (shared === undefined) {
    const connection = readClickHouseConnection("runtime");
    shared = connection
      ? new ClickHouseTrafficStore(createTrafficClickHouseClient(connection))
      : null;
  }
  return shared;
}
