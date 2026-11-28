/**
 * The production traffic store against a real ClickHouse, with the runtime and
 * migration identities production uses. CI runs it in the Production traffic
 * workflow against a pinned service container; elsewhere it skips unless a
 * test target is configured (see support/clickhouse-sandbox.ts).
 */
import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrateProductionTrafficSchema } from "../clickhouse-schema.js";
import {
  ClickHouseTrafficStore,
  createTrafficClickHouseClient,
} from "../clickhouse-store.js";
import {
  TrafficStoreUnavailableError,
  type CallRow,
  type OutcomeRow,
  type TrafficBatch,
} from "../store.js";
import {
  clickHouseTestTarget,
  createClickHouseSandbox,
  type ClickHouseSandbox,
} from "./support/clickhouse-sandbox.js";

const PROJECT = "proj_orders_lab";
const OTHER_PROJECT = "proj_other";
const NOW_NS = BigInt(Date.now()) * 1_000_000n;
const MS = 1_000_000n;
const WINDOW = { fromMs: Date.now() - 3_600_000, toMs: Date.now() + 60_000 };

const hex = (bytes: number) => randomBytes(bytes).toString("hex");

function call(overrides: Partial<CallRow> = {}): CallRow {
  return {
    traceId: hex(16),
    spanId: hex(8),
    parentSpanId: "",
    startTimeUnixNano: NOW_NS - 5_000n * MS,
    endTimeUnixNano: NOW_NS - 4_950n * MS,
    serviceName: "orders-lab",
    serviceVersion: "1.0.0-broken",
    deploymentEnvironment: "production",
    toolName: "refund_order",
    clientName: "claude-code",
    clientVersion: "2.1.0",
    protocolVersion: "2025-11-25",
    jsonrpcRequestId: "7",
    conversationId: "",
    errorType: "",
    rpcStatusCode: "",
    spanStatusCode: 0,
    arguments: null,
    result: null,
    ...overrides,
  };
}

function outcome(
  target: CallRow,
  status: "met" | "not_met",
  endOffsetMs: bigint,
  outcomeSpanId = hex(8),
): OutcomeRow {
  return {
    callTraceId: target.traceId,
    callSpanId: target.spanId,
    outcomeName: "refund_committed",
    outcomeStatus: status,
    outcomeEndTimeUnixNano: NOW_NS - 4_000n * MS + endOffsetMs * MS,
    outcomeTraceId: target.traceId,
    outcomeSpanId,
  };
}

const batch = (parts: Partial<TrafficBatch>): TrafficBatch => ({
  calls: [],
  outcomes: [],
  drops: [],
  ...parts,
});

describe.skipIf(!clickHouseTestTarget())(
  "ClickHouseTrafficStore on a real ClickHouse",
  () => {
    let sandbox: ClickHouseSandbox;
    let store: ClickHouseTrafficStore;

    beforeAll(async () => {
      sandbox = await createClickHouseSandbox();
      store = new ClickHouseTrafficStore(
        createTrafficClickHouseClient(sandbox.runtime),
      );
    }, 60_000);

    afterAll(async () => {
      await store?.close();
      await sandbox?.dispose();
    });

    it("refuses to serve before the schema is migrated, and only the migration identity can migrate", async () => {
      await expect(store.counts(PROJECT, WINDOW)).rejects.toBeInstanceOf(
        TrafficStoreUnavailableError,
      );
      const runtimeClient = createTrafficClickHouseClient(sandbox.runtime);
      await expect(
        migrateProductionTrafficSchema(runtimeClient),
      ).rejects.toMatchObject({ code: "497" });
      await runtimeClient.close();

      const migrationClient = createTrafficClickHouseClient(sandbox.migration);
      await expect(
        migrateProductionTrafficSchema(migrationClient),
      ).resolves.toEqual({ applied: [1], version: 1 });
      await expect(
        migrateProductionTrafficSchema(migrationClient),
      ).resolves.toEqual({ applied: [], version: 1 });
      await migrationClient.close();

      await expect(store.counts(PROJECT, WINDOW)).resolves.toMatchObject({
        received: 0,
      });
    });

    it("counts a resent batch once, before and after merges, per project", async () => {
      const refund = call();
      const failed = call({ toolName: "get_order", errorType: "-32603" });
      const first = batch({
        calls: [refund, failed],
        outcomes: [outcome(refund, "not_met", 0n)],
        drops: [
          { reason: "invalid_span", count: 2, batchDigest: "d1", day: today() },
        ],
      });
      await store.record(PROJECT, first);
      await store.record(PROJECT, first);
      await store.record(OTHER_PROJECT, batch({ calls: [call()] }));

      const expected = {
        received: 2,
        evaluated: 1,
        unmeasured: 1,
        flagged: expect.objectContaining({
          protocol_error: 1,
          outcome_not_met: 1,
        }),
        dropped: { invalid_span: 2 },
      };
      expect(await store.counts(PROJECT, WINDOW)).toMatchObject(expected);
      for (const table of [
        "mcp_tool_calls",
        "mcp_call_outcomes",
        "mcp_ingest_drops",
      ]) {
        await sandbox.optimize(table);
      }
      expect(await store.counts(PROJECT, WINDOW)).toMatchObject(expected);
      expect(await store.counts(OTHER_PROJECT, WINDOW)).toMatchObject({
        received: 1,
        evaluated: 0,
        dropped: {},
      });
    });

    it("chooses the latest outcome by its own end time, whatever order reports arrive in", async () => {
      const serviceName = `ordering-${hex(4)}`;
      const late = call({ serviceName });
      const stale = call({ serviceName });
      const tie = call({ serviceName });
      // An outcome delivered before its call still joins it.
      await store.record(
        PROJECT,
        batch({ outcomes: [outcome(late, "met", 0n)] }),
      );
      await store.record(PROJECT, batch({ calls: [late, stale, tie] }));
      // A newer report, then a retry of an older one that arrives after it.
      await store.record(
        PROJECT,
        batch({ outcomes: [outcome(stale, "met", 500n)] }),
      );
      await store.record(
        PROJECT,
        batch({ outcomes: [outcome(stale, "not_met", 100n)] }),
      );
      // Equal end times: the greater outcome span id wins.
      await store.record(
        PROJECT,
        batch({
          outcomes: [
            outcome(tie, "met", 200n, "00000000000000aa"),
            outcome(tie, "not_met", 200n, "00000000000000ff"),
          ],
        }),
      );

      const read = async () =>
        Object.fromEntries(
          (
            await store.listCalls(PROJECT, {
              ...WINDOW,
              serviceName,
              limit: 10,
            })
          ).map((row) => [row.ref, row.outcomes]),
        );
      const expected = {
        [`${late.traceId}:${late.spanId}`]: [
          { name: "refund_committed", status: "met" },
        ],
        [`${stale.traceId}:${stale.spanId}`]: [
          { name: "refund_committed", status: "met" },
        ],
        [`${tie.traceId}:${tie.spanId}`]: [
          { name: "refund_committed", status: "not_met" },
        ],
      };
      expect(await read()).toEqual(expected);
      await sandbox.optimize("mcp_call_outcomes");
      expect(await read()).toEqual(expected);
    });

    it("flags each review reason once, and keeps test copies out of production", async () => {
      const serviceName = `flags-${hex(4)}`;
      const rows = [
        call({ serviceName, errorType: "-32603" }),
        call({ serviceName, rpcStatusCode: "-32602" }),
        call({ serviceName, errorType: "tool_error" }),
        call({ serviceName }),
        call({ serviceName, deploymentEnvironment: "staging" }),
      ];
      await store.record(PROJECT, batch({ calls: rows }));
      const listed = await store.listCalls(PROJECT, {
        ...WINDOW,
        serviceName,
        limit: 10,
      });
      expect(listed).toHaveLength(4);
      const byRef = Object.fromEntries(
        listed.map((row) => [
          row.ref,
          row.reasons.filter((reason) => reason !== "random_sample"),
        ]),
      );
      expect(byRef[`${rows[0].traceId}:${rows[0].spanId}`]).toEqual([
        "protocol_error",
      ]);
      expect(byRef[`${rows[1].traceId}:${rows[1].spanId}`]).toEqual([
        "rejected_request",
      ]);
      expect(byRef[`${rows[2].traceId}:${rows[2].spanId}`]).toEqual([
        "tool_error",
      ]);
      expect(byRef[`${rows[3].traceId}:${rows[3].spanId}`]).toEqual([]);

      const filtered = await store.listCalls(PROJECT, {
        ...WINDOW,
        serviceName,
        reason: "tool_error",
        limit: 10,
      });
      expect(filtered.map((row) => row.ref)).toEqual([
        `${rows[2].traceId}:${rows[2].spanId}`,
      ]);
    });

    it("samples a stable share of calls by span id", async () => {
      const serviceName = `sample-${hex(4)}`;
      await store.record(
        PROJECT,
        batch({
          calls: Array.from({ length: 400 }, () => call({ serviceName })),
        }),
      );
      const window = { ...WINDOW, serviceName };
      const counts = await store.counts(PROJECT, window);
      const sampled = await store.listCalls(PROJECT, {
        ...window,
        reason: "random_sample",
        limit: 400,
      });
      expect(counts.received).toBe(400);
      expect(counts.flagged.random_sample).toBe(sampled.length);
      expect(sampled.length).toBeGreaterThan(0);
      expect(sampled.length).toBeLessThan(80);
      const again = await store.listCalls(PROJECT, {
        ...window,
        reason: "random_sample",
        limit: 400,
      });
      expect(again.map((row) => row.ref)).toEqual(
        sampled.map((row) => row.ref),
      );
    });

    it("hides a source past its retention even inside the requested window", async () => {
      const serviceName = `expired-${hex(4)}`;
      const oldStart = NOW_NS - 31n * 86_400_000n * MS;
      await store.record(
        PROJECT,
        batch({
          calls: [
            call({
              serviceName,
              startTimeUnixNano: oldStart,
              endTimeUnixNano: oldStart + 10n * MS,
            }),
          ],
        }),
      );
      const counts = await store.counts(PROJECT, {
        fromMs: Date.now() - 40 * 86_400_000,
        toMs: Date.now(),
        serviceName,
      });
      expect(counts.received).toBe(0);
    });
  },
);

function today(): string {
  return new Date().toISOString().slice(0, 10);
}
