/**
 * The production traffic schema, applied in numbered steps by the migration
 * identity (`npm run production-traffic:migrate`). The runtime identity
 * cannot change it, and refuses to serve until the database is at
 * `PRODUCTION_TRAFFIC_SCHEMA_VERSION`, so a receiver never writes to tables
 * it does not understand.
 *
 * Every statement is idempotent, so two installs racing an upgrade, or a
 * migration retried after a failure, end in the same state.
 */
import type { ClickHouseClient } from "@clickhouse/client";

export const PRODUCTION_TRAFFIC_SCHEMA_VERSION = 1;

/** Source observations expire after this many days (engineering spec E4, E15). */
export const SOURCE_RETENTION_DAYS = 30;

const MIGRATIONS_TABLE = "production_traffic_schema_migrations";

type Migration = { version: number; description: string; statements: string[] };

const MIGRATIONS: Migration[] = [
  {
    version: 1,
    description: "tool calls, outcome reports and known ingest drops",
    statements: [
      // One row per `tools/call` span. A re-sent span has the same sort key,
      // so it collapses on merge and reads use FINAL. Content columns stay
      // NULL unless the project stores arguments and results.
      `CREATE TABLE IF NOT EXISTS mcp_tool_calls
      (
        project_id String,
        trace_id String,
        span_id String,
        parent_span_id String,
        start_time DateTime64(9, 'UTC'),
        end_time DateTime64(9, 'UTC'),
        service_name LowCardinality(String),
        service_version LowCardinality(String),
        deployment_environment LowCardinality(String),
        tool_name String,
        client_name LowCardinality(String),
        client_version LowCardinality(String),
        protocol_version LowCardinality(String),
        jsonrpc_request_id String,
        conversation_id String,
        error_type LowCardinality(String),
        rpc_status_code LowCardinality(String),
        span_status_code UInt8,
        arguments Nullable(String),
        result Nullable(String),
        received_at DateTime64(3, 'UTC') DEFAULT now64(3)
      )
      ENGINE = ReplacingMergeTree
      PARTITION BY toYYYYMMDD(start_time)
      ORDER BY (project_id, start_time, trace_id, span_id)
      TTL toDateTime(start_time) + INTERVAL ${SOURCE_RETENTION_DAYS} DAY
      SETTINGS ttl_only_drop_parts = 1`,
      // Every distinct outcome report is kept; the sort key ends in the
      // report's own end time and span id, so only an exact resend collapses.
      // The current outcome is chosen at read time by the greatest
      // (outcome_end_time, outcome_span_id), which no merge, restart or
      // arrival order can change.
      `CREATE TABLE IF NOT EXISTS mcp_call_outcomes
      (
        project_id String,
        call_trace_id String,
        call_span_id String,
        outcome_name String,
        outcome_status LowCardinality(String),
        outcome_end_time DateTime64(9, 'UTC'),
        outcome_trace_id String,
        outcome_span_id String,
        received_at DateTime64(3, 'UTC') DEFAULT now64(3)
      )
      ENGINE = ReplacingMergeTree
      PARTITION BY toYYYYMMDD(outcome_end_time)
      ORDER BY (project_id, call_trace_id, call_span_id, outcome_name, outcome_end_time, outcome_span_id)
      TTL toDateTime(outcome_end_time) + INTERVAL ${SOURCE_RETENTION_DAYS} DAY
      SETTINGS ttl_only_drop_parts = 1`,
      // Spans the receiver refused, counted per batch. Keyed by the batch's
      // digest, so replaying the same bytes cannot count them twice.
      `CREATE TABLE IF NOT EXISTS mcp_ingest_drops
      (
        project_id String,
        day Date,
        reason LowCardinality(String),
        batch_digest String,
        dropped UInt64,
        received_at DateTime64(3, 'UTC') DEFAULT now64(3)
      )
      ENGINE = ReplacingMergeTree
      ORDER BY (project_id, day, reason, batch_digest)
      TTL day + INTERVAL ${SOURCE_RETENTION_DAYS} DAY`,
    ],
  },
];

const CREATE_MIGRATIONS_TABLE = `CREATE TABLE IF NOT EXISTS ${MIGRATIONS_TABLE}
(
  version UInt32,
  description String,
  applied_at DateTime64(3, 'UTC') DEFAULT now64(3)
)
ENGINE = ReplacingMergeTree
ORDER BY version`;

/** ClickHouse's code for a table that does not exist. */
const UNKNOWN_TABLE = "60";

function isUnknownTable(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    String((error as { code: unknown }).code) === UNKNOWN_TABLE
  );
}

/** The applied schema version; 0 for a database that was never migrated. */
export async function readSchemaVersion(
  client: ClickHouseClient,
): Promise<number> {
  try {
    const result = await client.query({
      query: `SELECT max(version) AS version FROM ${MIGRATIONS_TABLE} FINAL`,
      format: "JSONEachRow",
    });
    const rows = await result.json<{ version: number | string }>();
    return Number(rows[0]?.version ?? 0);
  } catch (error) {
    if (isUnknownTable(error)) return 0;
    throw error;
  }
}

export async function migrateProductionTrafficSchema(
  client: ClickHouseClient,
): Promise<{ applied: number[]; version: number }> {
  await client.command({ query: CREATE_MIGRATIONS_TABLE });
  const current = await readSchemaVersion(client);
  const applied: number[] = [];
  for (const migration of MIGRATIONS) {
    if (migration.version <= current) continue;
    for (const statement of migration.statements) {
      await client.command({ query: statement });
    }
    await client.insert({
      table: MIGRATIONS_TABLE,
      values: [
        { version: migration.version, description: migration.description },
      ],
      format: "JSONEachRow",
    });
    applied.push(migration.version);
  }
  return { applied, version: await readSchemaVersion(client) };
}
