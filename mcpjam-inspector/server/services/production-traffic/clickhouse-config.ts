/**
 * Where production traffic (PT-1) is stored: a ClickHouse database the
 * deployment names, reached as one of two identities.
 *
 * The runtime identity ingests and reads; it needs SELECT and INSERT on the
 * database and nothing else. The migration identity owns the schema and is
 * used only by the migration command, so a compromised receiver cannot alter
 * or drop tables. Hosted and self-hosted installs bind the same variables, the
 * latter from Kubernetes Secrets, with the operator's CA when the endpoint is
 * private.
 */
import { readFileSync } from "node:fs";

export const PRODUCTION_TRAFFIC_CLICKHOUSE_ENV = {
  url: "PRODUCTION_TRAFFIC_CLICKHOUSE_URL",
  database: "PRODUCTION_TRAFFIC_CLICKHOUSE_DATABASE",
  user: "PRODUCTION_TRAFFIC_CLICKHOUSE_USER",
  password: "PRODUCTION_TRAFFIC_CLICKHOUSE_PASSWORD",
  migrationUser: "PRODUCTION_TRAFFIC_CLICKHOUSE_MIGRATION_USER",
  migrationPassword: "PRODUCTION_TRAFFIC_CLICKHOUSE_MIGRATION_PASSWORD",
  caCertPath: "PRODUCTION_TRAFFIC_CLICKHOUSE_CA_CERT_PATH",
} as const;

export const DEFAULT_PRODUCTION_TRAFFIC_DATABASE = "mcpjam_production_traffic";

export type ClickHouseIdentity = "runtime" | "migration";

export type ClickHouseConnection = {
  url: string;
  database: string;
  username: string;
  password: string;
  /** PEM bundle for a private endpoint's issuing CA. */
  caCert?: Buffer;
};

type Env = Record<string, string | undefined>;

const DATABASE_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/;

function value(env: Env, name: string): string | undefined {
  const raw = env[name]?.trim();
  return raw ? raw : undefined;
}

/**
 * The connection for one identity, or null when this deployment has no
 * production traffic store at all (the URL is unset). A URL without the
 * identity's credentials is a configuration error and throws, naming the
 * missing variable but never a value.
 */
export function readClickHouseConnection(
  identity: ClickHouseIdentity,
  env: Env = process.env,
): ClickHouseConnection | null {
  const names = PRODUCTION_TRAFFIC_CLICKHOUSE_ENV;
  const url = value(env, names.url);
  if (!url) return null;
  const parsed = new URL(url);
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error(`${names.url} must be an http(s) URL`);
  }
  if (parsed.username || parsed.password) {
    throw new Error(
      `${names.url} must not carry credentials; set the user and password variables instead`,
    );
  }
  const database =
    value(env, names.database) ?? DEFAULT_PRODUCTION_TRAFFIC_DATABASE;
  if (!DATABASE_NAME.test(database)) {
    throw new Error(`${names.database} is not a valid database name`);
  }
  const userName = identity === "migration" ? names.migrationUser : names.user;
  const passwordName =
    identity === "migration" ? names.migrationPassword : names.password;
  const username = value(env, userName);
  const password = env[passwordName];
  if (!username) throw new Error(`${userName} is not set`);
  if (password === undefined) throw new Error(`${passwordName} is not set`);
  const caCertPath = value(env, names.caCertPath);
  return {
    url,
    database,
    username,
    password,
    ...(caCertPath ? { caCert: readFileSync(caCertPath) } : {}),
  };
}
