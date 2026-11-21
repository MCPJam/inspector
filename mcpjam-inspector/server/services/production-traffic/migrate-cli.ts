/**
 * `npm run production-traffic:migrate -w @mcpjam/inspector`
 *
 * Brings the production traffic database to the schema this checkout
 * expects, connecting as the migration identity. Run it at install and on
 * every upgrade, before the new Inspector serves. It prints the database
 * name and versions, never a credential.
 */
import { readClickHouseConnection } from "./clickhouse-config.js";
import { migrateProductionTrafficSchema } from "./clickhouse-schema.js";
import { createTrafficClickHouseClient } from "./clickhouse-store.js";

const connection = readClickHouseConnection("migration");
if (!connection) {
  process.stderr.write(
    "PRODUCTION_TRAFFIC_CLICKHOUSE_URL is not set, so this deployment has no production traffic database to migrate.\n",
  );
  process.exit(1);
}

const client = createTrafficClickHouseClient(connection);
try {
  const { applied, version } = await migrateProductionTrafficSchema(client);
  process.stdout.write(
    `${JSON.stringify({ database: connection.database, applied, version })}\n`,
  );
} finally {
  await client.close();
}
