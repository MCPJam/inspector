/**
 * A disposable ClickHouse database for the real-database tests, with the two
 * identities production uses: a migration user that owns the schema and a
 * runtime user limited to SELECT and INSERT. Both passwords are generated
 * here, so nothing outside the job ever holds them.
 *
 * CI provides an administrator for a throwaway service container through
 * PRODUCTION_TRAFFIC_TEST_CLICKHOUSE_URL, _ADMIN_USER and _ADMIN_PASSWORD.
 * Without them the suites skip, unless PRODUCTION_TRAFFIC_REQUIRE_CLICKHOUSE=1
 * says this run must not skip.
 */
import { randomBytes } from "node:crypto";
import { createClient, type ClickHouseClient } from "@clickhouse/client";
import type { ClickHouseConnection } from "../../clickhouse-config.js";

export type ClickHouseSandbox = {
  admin: ClickHouseClient;
  database: string;
  migration: ClickHouseConnection;
  runtime: ClickHouseConnection;
  /** Forces pending merges, so a test can check what survives them. */
  optimize(table: string): Promise<void>;
  dispose(): Promise<void>;
};

export function clickHouseTestTarget() {
  const url = process.env.PRODUCTION_TRAFFIC_TEST_CLICKHOUSE_URL?.trim();
  if (!url) {
    if (process.env.PRODUCTION_TRAFFIC_REQUIRE_CLICKHOUSE === "1") {
      throw new Error(
        "PRODUCTION_TRAFFIC_REQUIRE_CLICKHOUSE=1 but PRODUCTION_TRAFFIC_TEST_CLICKHOUSE_URL is not set",
      );
    }
    return null;
  }
  return {
    url,
    username: process.env.PRODUCTION_TRAFFIC_TEST_CLICKHOUSE_ADMIN_USER ?? "",
    password:
      process.env.PRODUCTION_TRAFFIC_TEST_CLICKHOUSE_ADMIN_PASSWORD ?? "",
  };
}

const secret = () => randomBytes(24).toString("base64url");

export async function createClickHouseSandbox(): Promise<ClickHouseSandbox> {
  const target = clickHouseTestTarget();
  if (!target) throw new Error("No ClickHouse test target is configured");
  const admin = createClient(target);
  const suffix = randomBytes(6).toString("hex");
  const database = `pt_test_${suffix}`;
  const migrationUser = `pt_migrator_${suffix}`;
  const runtimeUser = `pt_runtime_${suffix}`;
  const migrationPassword = secret();
  const runtimePassword = secret();
  // base64url passwords and hex suffixes contain no quote or backslash, so
  // they are safe to place in these statements directly.
  for (const query of [
    `CREATE DATABASE ${database}`,
    `CREATE USER ${migrationUser} IDENTIFIED WITH sha256_password BY '${migrationPassword}' DEFAULT DATABASE ${database}`,
    `GRANT CREATE TABLE, ALTER TABLE, DROP TABLE, SELECT, INSERT ON ${database}.* TO ${migrationUser}`,
    `CREATE USER ${runtimeUser} IDENTIFIED WITH sha256_password BY '${runtimePassword}' DEFAULT DATABASE ${database}`,
    `GRANT SELECT, INSERT ON ${database}.* TO ${runtimeUser}`,
  ]) {
    await admin.command({ query });
  }
  const connection = (username: string, password: string) => ({
    url: target.url,
    database,
    username,
    password,
  });
  return {
    admin,
    database,
    migration: connection(migrationUser, migrationPassword),
    runtime: connection(runtimeUser, runtimePassword),
    optimize: async (table) => {
      await admin.command({
        query: `OPTIMIZE TABLE ${database}.${table} FINAL`,
      });
    },
    dispose: async () => {
      for (const query of [
        `DROP DATABASE IF EXISTS ${database}`,
        `DROP USER IF EXISTS ${migrationUser}`,
        `DROP USER IF EXISTS ${runtimeUser}`,
      ]) {
        await admin.command({ query });
      }
      await admin.close();
    },
  };
}
