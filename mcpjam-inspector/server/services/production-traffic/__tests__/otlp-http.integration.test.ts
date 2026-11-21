/**
 * The OTLP receiver end to end over HTTP: the registered Inspector app with
 * every production middleware, a real ClickHouse behind the runtime identity,
 * and a stand-in Convex speaking the real client protocol. The protobuf path
 * is exercised by the official OpenTelemetry Python exporter.
 *
 * Runs in the Production traffic workflow; skips elsewhere unless a
 * ClickHouse test target is configured (support/clickhouse-sandbox.ts).
 */
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { appendFileSync } from "node:fs";
import { resolve } from "node:path";
import { gzipSync } from "node:zlib";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { clickHouseTestTarget } from "./support/clickhouse-sandbox.js";
import {
  OTHER_PROJECT,
  PROJECT,
  producerToken,
  startReceiverHarness,
  type ReceiverHarness,
} from "./support/receiver-harness.js";

const PYTHON = process.env.PRODUCTION_TRAFFIC_TEST_PYTHON;
const EXPORTER = resolve(
  __dirname,
  "../../../../scripts/production-traffic/otlp_export.py",
);
const HOUR_MS = 3_600_000;

const hex = (bytes: number) => randomBytes(bytes).toString("hex");
const nowNs = () => BigInt(Date.now()) * 1_000_000n;
const window = (serviceName: string) => ({
  fromMs: Date.now() - HOUR_MS,
  toMs: Date.now() + HOUR_MS,
  serviceName,
});

type Ids = { traceId: string; spanId: string };
type Attr = { key: string; value: Record<string, string> };
const attr = (key: string, value: string | number): Attr =>
  typeof value === "number"
    ? { key, value: { intValue: String(value) } }
    : { key, value: { stringValue: value } };
const newIds = (): Ids => ({ traceId: hex(16), spanId: hex(8) });

function callSpan(ids: Ids, toolName: string | null, extra: Attr[] = []) {
  const start = nowNs() - 2_000_000_000n;
  return {
    ...ids,
    name: `tools/call ${toolName ?? "unknown"}`,
    kind: 2,
    startTimeUnixNano: String(start),
    endTimeUnixNano: String(start + 40_000_000n),
    attributes: [
      attr("mcp.method.name", "tools/call"),
      ...(toolName ? [attr("gen_ai.tool.name", toolName)] : []),
      attr("mcp.client.name", "codex"),
      // Must never be stored while the project keeps metadata only.
      attr("gen_ai.tool.call.arguments", '{"order_id":"1042"}'),
      attr("customer.email", "fictional@example.com"),
      ...extra,
    ],
  };
}

function outcomeSpan(
  call: Ids,
  status: "met" | "not_met",
  endNs: bigint,
  spanId = hex(8),
) {
  return {
    traceId: call.traceId,
    spanId,
    parentSpanId: call.spanId,
    name: "mcpjam.outcome",
    kind: 1,
    startTimeUnixNano: String(endNs - 1_000_000n),
    endTimeUnixNano: String(endNs),
    attributes: [
      attr("mcpjam.outcome.name", "refund_committed"),
      attr("mcpjam.outcome.status", status),
    ],
  };
}

const exportRequest = (serviceName: string, spans: unknown[]) =>
  JSON.stringify({
    resourceSpans: [
      {
        resource: {
          attributes: [
            attr("service.name", serviceName),
            attr("service.version", "1.0.0-broken"),
            attr("deployment.environment.name", "production"),
          ],
        },
        scopeSpans: [{ scope: { name: "pt1-fixture" }, spans }],
      },
    ],
  });

/** Async on purpose: the app under test shares this process's event loop. */
function runPython(
  args: string[],
  env: NodeJS.ProcessEnv,
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((done) => {
    const child = spawn(PYTHON!, args, { env });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    const timer = setTimeout(() => child.kill("SIGKILL"), 60_000);
    child.on("close", (status) => {
      clearTimeout(timer);
      done({ status, stdout, stderr });
    });
  });
}

describe.skipIf(!clickHouseTestTarget())(
  "OTLP receiver over HTTP on a real ClickHouse",
  () => {
    let harness: ReceiverHarness;
    const evidence: Record<string, unknown> = {};

    beforeAll(async () => {
      if (process.env.PRODUCTION_TRAFFIC_REQUIRE_PYTHON === "1" && !PYTHON) {
        throw new Error(
          "PRODUCTION_TRAFFIC_REQUIRE_PYTHON=1 but PRODUCTION_TRAFFIC_TEST_PYTHON is not set",
        );
      }
      harness = await startReceiverHarness();
    }, 180_000);

    afterAll(async () => {
      await harness?.close();
      const summary = process.env.GITHUB_STEP_SUMMARY;
      if (summary) {
        appendFileSync(
          summary,
          `### Production traffic receiver (synthetic ids)\n\n\`\`\`json\n${JSON.stringify(evidence, null, 2)}\n\`\`\`\n`,
        );
      }
    });

    it("accepts a JSON export once, keeps only allowed attributes and reports a refused span", async () => {
      const serviceName = `json-${hex(4)}`;
      const refund = newIds();
      const failed = newIds();
      const body = exportRequest(serviceName, [
        callSpan(refund, "refund_order"),
        outcomeSpan(refund, "not_met", nowNs() - 1_000_000_000n),
        callSpan(failed, "get_order", [attr("error.type", "-32603")]),
        callSpan(newIds(), null),
      ]);
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const response = await harness.post(body);
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({
          partialSuccess: {
            rejectedSpans: "1",
            errorMessage: expect.stringContaining("1 missing_tool_name"),
          },
        });
      }

      const counts = await harness.store.counts(PROJECT, window(serviceName));
      expect(counts).toMatchObject({
        rulesVersion: 1,
        received: 2,
        evaluated: 1,
        unmeasured: 1,
        flagged: { protocol_error: 1, outcome_not_met: 1, tool_error: 0 },
      });
      expect(counts.dropped).toMatchObject({ missing_tool_name: 1 });
      const calls = await harness.store.listCalls(PROJECT, {
        ...window(serviceName),
        limit: 10,
      });
      expect(
        calls.find((call) => call.ref === `${refund.traceId}:${refund.spanId}`),
      ).toMatchObject({
        toolName: "refund_order",
        clientName: "codex",
        outcomes: [{ name: "refund_committed", status: "not_met" }],
        reasons: expect.arrayContaining(["outcome_not_met"]),
      });

      const stored = await harness.sandbox.admin.query({
        query: `SELECT arguments, result FROM ${harness.sandbox.database}.mcp_tool_calls FINAL WHERE service_name = {serviceName:String}`,
        query_params: { serviceName },
        format: "JSONEachRow",
      });
      const rows = await stored.json<{ arguments: unknown; result: unknown }>();
      expect(rows).toHaveLength(2);
      expect(
        rows.every((row) => row.arguments === null && row.result === null),
      ).toBe(true);
      evidence.json = { serviceName, counts, calls };
    });

    it.skipIf(!PYTHON)(
      "accepts the official Python exporter's gzip protobuf export",
      async () => {
        const serviceName = `python-${hex(4)}`;
        const run = await runPython(
          [
            EXPORTER,
            "--endpoint",
            `${harness.base}/api/v1/projects/${PROJECT}/otlp/v1/traces`,
            "--service-name",
            serviceName,
            "--gzip",
          ],
          { ...process.env, MCPJAM_PRODUCER_TOKEN: harness.writer },
        );
        expect(run.stderr).not.toContain(harness.writer);
        expect(run.status, run.stderr).toBe(0);
        const sent = JSON.parse(run.stdout.trim().split("\n").pop()!);
        expect(sent.export).toBe("SUCCESS");
        const calls = await harness.store.listCalls(PROJECT, {
          ...window(serviceName),
          limit: 10,
        });
        expect(calls).toEqual([
          expect.objectContaining({
            ref: `${sent.traceId}:${sent.callSpanId}`,
            toolName: "refund_order",
            clientName: "claude-code",
            serviceVersion: "1.0.0-broken",
            outcomes: [{ name: "refund_committed", status: "not_met" }],
          }),
        ]);
        evidence.python = { sent, calls };
      },
      90_000,
    );

    it("orders outcomes by their own end time, whatever order they arrive in", async () => {
      const serviceName = `ordering-${hex(4)}`;
      const early = newIds();
      const retried = newIds();
      const tied = newIds();
      const t = nowNs() - 500_000_000n;
      const send = async (spans: unknown[]) =>
        expect(
          (await harness.post(exportRequest(serviceName, spans))).status,
        ).toBe(200);
      await send([outcomeSpan(early, "met", t)]);
      await send([
        callSpan(early, "refund_order"),
        callSpan(retried, "refund_order"),
        callSpan(tied, "refund_order"),
      ]);
      await send([outcomeSpan(retried, "met", t + 2_000_000n)]);
      await send([outcomeSpan(retried, "not_met", t + 1_000_000n)]);
      await send([
        outcomeSpan(tied, "met", t, "00000000000000aa"),
        outcomeSpan(tied, "not_met", t, "00000000000000ff"),
      ]);
      const calls = await harness.store.listCalls(PROJECT, {
        ...window(serviceName),
        limit: 10,
      });
      const outcomesOf = (ids: Ids) =>
        calls.find((call) => call.ref === `${ids.traceId}:${ids.spanId}`)
          ?.outcomes;
      const met = [{ name: "refund_committed", status: "met" }];
      expect(outcomesOf(early)).toEqual(met);
      expect(outcomesOf(retried)).toEqual(met);
      expect(outcomesOf(tied)).toEqual([
        { name: "refund_committed", status: "not_met" },
      ]);
      evidence.ordering = { serviceName, calls };
    });

    it("refuses another project, a revoked credential and a missing one", async () => {
      const body = exportRequest(`refusals-${hex(4)}`, [
        callSpan(newIds(), "get_order"),
      ]);
      const other = await harness.post(body, { project: OTHER_PROJECT });
      expect(other.status).toBe(403);
      expect((await other.json()).message).toMatch(/different project/);

      const missing = await fetch(
        `${harness.base}/api/v1/projects/${PROJECT}/otlp/v1/traces`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body,
        },
      );
      expect(missing.status).toBe(401);

      const revoked = producerToken();
      harness.convex.addCredential(revoked, PROJECT);
      expect((await harness.post(body, { token: revoked })).status).toBe(200);
      harness.convex.revoke(revoked);
      const afterRevoke = await harness.post(body, { token: revoked });
      expect(afterRevoke.status).toBe(401);
      expect((await afterRevoke.json()).message).toMatch(/revoked/);
    });

    it("asks the exporter to retry while storage refuses writes", async () => {
      const { admin, database, runtime } = harness.sandbox;
      await admin.command({
        query: `REVOKE INSERT ON ${database}.* FROM ${runtime.username}`,
      });
      try {
        const response = await harness.post(
          exportRequest(`outage-${hex(4)}`, [callSpan(newIds(), "get_order")]),
        );
        expect(response.status).toBe(503);
        expect(response.headers.get("retry-after")).toBe("5");
      } finally {
        await admin.command({
          query: `GRANT INSERT ON ${database}.* TO ${runtime.username}`,
        });
      }
    });
    it("bounds its own body sizes without loosening the rest of /api/v1", async () => {
      const serviceName = `sizes-${hex(4)}`;
      const large = exportRequest(
        serviceName,
        Array.from({ length: 2_500 }, () => callSpan(newIds(), "get_order")),
      );
      expect(large.length).toBeGreaterThan(1024 * 1024);
      expect(large.length).toBeLessThan(5 * 1024 * 1024);
      const accepted = await harness.post(gzipSync(large), {
        headers: { "Content-Encoding": "gzip" },
      });
      expect(accepted.status).toBe(200);
      const counts = await harness.store.counts(PROJECT, window(serviceName));
      expect(counts.received).toBe(2_500);

      const tooLarge = await harness.post("x".repeat(5 * 1024 * 1024 + 1));
      expect(tooLarge.status).toBe(413);
      const bomb = gzipSync(Buffer.alloc(6 * 1024 * 1024, 0x20));
      const inflated = await harness.post(bomb, {
        headers: { "Content-Encoding": "gzip" },
      });
      expect(inflated.status).toBe(413);

      // A neighbouring v1 route keeps the ordinary 1MB JSON cap.
      const neighbour = await fetch(
        `${harness.base}/api/v1/projects/${PROJECT}/eval-ingest/runs`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: "Bearer any",
          },
          body: JSON.stringify({ padding: "x".repeat(1024 * 1024 + 1) }),
        },
      );
      expect(neighbour.status).toBe(400);
      expect((await neighbour.json()).message).toMatch(/1MB/);
    });
  },
);
