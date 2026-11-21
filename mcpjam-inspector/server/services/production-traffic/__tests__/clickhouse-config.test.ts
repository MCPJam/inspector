import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_PRODUCTION_TRAFFIC_DATABASE,
  readClickHouseConnection,
} from "../clickhouse-config.js";
import { toDateTime64 } from "../clickhouse-store.js";

const base = {
  PRODUCTION_TRAFFIC_CLICKHOUSE_URL: "https://clickhouse.internal:8443",
  PRODUCTION_TRAFFIC_CLICKHOUSE_USER: "pt_runtime",
  PRODUCTION_TRAFFIC_CLICKHOUSE_PASSWORD: "runtime-secret",
  PRODUCTION_TRAFFIC_CLICKHOUSE_MIGRATION_USER: "pt_migrator",
  PRODUCTION_TRAFFIC_CLICKHOUSE_MIGRATION_PASSWORD: "migration-secret",
};

describe("readClickHouseConnection", () => {
  it("is off when the deployment names no database URL", () => {
    expect(readClickHouseConnection("runtime", {})).toBeNull();
  });

  it("gives each identity its own credentials", () => {
    expect(readClickHouseConnection("runtime", base)).toEqual({
      url: base.PRODUCTION_TRAFFIC_CLICKHOUSE_URL,
      database: DEFAULT_PRODUCTION_TRAFFIC_DATABASE,
      username: "pt_runtime",
      password: "runtime-secret",
    });
    expect(readClickHouseConnection("migration", base)).toMatchObject({
      username: "pt_migrator",
      password: "migration-secret",
    });
  });

  it("names a missing variable without echoing any value", () => {
    const { PRODUCTION_TRAFFIC_CLICKHOUSE_MIGRATION_USER: _, ...env } = base;
    expect(() => readClickHouseConnection("migration", env)).toThrow(
      "PRODUCTION_TRAFFIC_CLICKHOUSE_MIGRATION_USER is not set",
    );
  });

  it("refuses credentials in the URL and an unsafe database name", () => {
    expect(() =>
      readClickHouseConnection("runtime", {
        ...base,
        PRODUCTION_TRAFFIC_CLICKHOUSE_URL:
          "https://user:pw@clickhouse.internal",
      }),
    ).toThrow(/must not carry credentials/);
    expect(() =>
      readClickHouseConnection("runtime", {
        ...base,
        PRODUCTION_TRAFFIC_CLICKHOUSE_DATABASE: "traffic; DROP TABLE x",
      }),
    ).toThrow(/not a valid database name/);
  });

  it("loads the operator's CA bundle for a private endpoint", () => {
    const dir = mkdtempSync(join(tmpdir(), "pt-ca-"));
    try {
      const path = join(dir, "ca.pem");
      writeFileSync(path, "-----BEGIN CERTIFICATE-----\nfixture\n");
      const connection = readClickHouseConnection("runtime", {
        ...base,
        PRODUCTION_TRAFFIC_CLICKHOUSE_CA_CERT_PATH: path,
      });
      expect(connection?.caCert?.toString()).toContain("BEGIN CERTIFICATE");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("toDateTime64", () => {
  it("keeps every nanosecond of an OTLP timestamp", () => {
    expect(toDateTime64(1_763_618_400_123_456_789n)).toBe(
      "2025-11-20 06:00:00.123456789",
    );
    expect(toDateTime64(1_000_000_007n)).toBe("1970-01-01 00:00:01.000000007");
  });
});
