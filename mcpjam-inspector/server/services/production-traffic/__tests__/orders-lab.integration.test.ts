/**
 * The fictional orders lab (scripts/production-traffic/orders_lab.py) on the
 * official MCP Python SDK, exporting to the registered app over real OTLP:
 * the SDK's own call spans plus the lab's outcome reports land as calls with
 * the review flags the PT-1 QA scenarios expect, read back by a member.
 *
 * Runs in the Production traffic workflow; skips elsewhere unless a
 * ClickHouse test target and a Python with the lab's packages are configured.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { appendFileSync } from "node:fs";
import { createServer, type AddressInfo } from "node:net";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { clickHouseTestTarget } from "./support/clickhouse-sandbox.js";
import {
  PROJECT,
  startReceiverHarness,
  type ReceiverHarness,
} from "./support/receiver-harness.js";

const LAB = resolve(
  __dirname,
  "../../../../scripts/production-traffic/orders_lab.py",
);
const PYTHON = process.env.PRODUCTION_TRAFFIC_TEST_PYTHON?.trim();
if (process.env.PRODUCTION_TRAFFIC_REQUIRE_PYTHON === "1" && !PYTHON) {
  throw new Error(
    "PRODUCTION_TRAFFIC_REQUIRE_PYTHON=1 but PRODUCTION_TRAFFIC_TEST_PYTHON is not set",
  );
}
const READER = `reader.${randomBytes(12).toString("hex")}`;

type Lab = { url: string; service: string; stop(): Promise<string> };
type RpcReply = { result?: { isError?: boolean }; error?: { code: number } };

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((done) => server.close(() => done()));
  return port;
}

/** A minimal streamable HTTP client: initialize, then plain JSON-RPC calls. */
async function connect(url: string, clientName: string) {
  let id = 0;
  let session = "";
  const post = async (body: object) => {
    const response = await fetch(`${url}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        ...(session
          ? { "Mcp-Session-Id": session, "MCP-Protocol-Version": "2025-06-18" }
          : {}),
      },
      body: JSON.stringify({ jsonrpc: "2.0", ...body }),
    });
    session ||= response.headers.get("mcp-session-id") ?? "";
    return response.status === 202 ? null : ((await response.json()) as RpcReply);
  };
  await post({
    id: ++id,
    method: "initialize",
    params: {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: clientName, version: "1.0.0" },
    },
  });
  await post({ method: "notifications/initialized" });
  return (name: string, args: Record<string, unknown> = {}) =>
    post({ id: ++id, method: "tools/call", params: { name, arguments: args } });
}

describe.skipIf(!clickHouseTestTarget())("Orders lab over OTLP", () => {
  let harness: ReceiverHarness;
  const liveLabs = new Set<Lab>();
  const evidence: Record<string, unknown> = {};

  async function startLab(options: string[]): Promise<Lab> {
    if (!PYTHON) {
      throw new Error("Set PRODUCTION_TRAFFIC_TEST_PYTHON to start the orders lab");
    }
    const port = await freePort();
    const service = `orders-lab-${randomBytes(4).toString("hex")}`;
    const child: ChildProcess = spawn(
      PYTHON,
      [
        LAB,
        "--otlp-endpoint",
        `${harness.base}/api/v1/projects/${PROJECT}/otlp/v1/traces`,
        "--service-name",
        service,
        "--port",
        String(port),
        ...options,
      ],
      {
        env: {
          ...process.env,
          MCPJAM_PRODUCER_TOKEN: harness.writer,
          OTEL_BSP_SCHEDULE_DELAY: "100",
        },
      },
    );
    let output = "";
    let spawnError: Error | undefined;
    let killDeadline: ReturnType<typeof setTimeout> | undefined;
    child.stdout?.on("data", (chunk) => (output += chunk));
    child.stderr?.on("data", (chunk) => (output += chunk));
    child.on("error", (error) => {
      spawnError = error;
    });
    const exited = new Promise<void>((done) => {
      child.once("close", () => {
        clearTimeout(killDeadline);
        liveLabs.delete(lab);
        done();
      });
    });
    const url = `http://127.0.0.1:${port}`;
    const lab: Lab = {
      url,
      service,
      stop: async () => {
        // SIGTERM lets the lab flush spans. Bound cleanup if it never exits.
        if (
          child.pid &&
          child.exitCode === null &&
          child.signalCode === null &&
          !killDeadline
        ) {
          child.kill("SIGTERM");
          killDeadline = setTimeout(() => child.kill("SIGKILL"), 25_000);
        }
        await exited;
        return output;
      },
    };
    liveLabs.add(lab);
    const deadline = Date.now() + 30_000;
    while (
      !spawnError &&
      child.exitCode === null &&
      child.signalCode === null &&
      Date.now() < deadline
    ) {
      const ready = await fetch(`${url}/orders`, {
        signal: AbortSignal.timeout(1_000),
      }).then((response) => response.ok, () => false);
      if (ready) return lab;
      await new Promise((done) => setTimeout(done, 200));
    }
    const diagnostic = output.replaceAll(harness.writer, "[redacted]");
    throw new Error(`The orders lab did not start:\n${diagnostic}`, {
      cause: spawnError,
    });
  }

  const read = async (path: string, query: Record<string, string>) => {
    const window = {
      from: String(Date.now() - 3_600_000),
      to: String(Date.now() + 60_000),
    };
    const response = await fetch(
      `${harness.base}/api/v1/projects/${PROJECT}/production/${path}?${new URLSearchParams({ ...window, ...query })}`,
      { headers: { Authorization: `Bearer ${READER}` } },
    );
    expect(response.status).toBe(200);
    return response.json();
  };

  beforeAll(async () => {
    harness = await startReceiverHarness();
    harness.convex.addMember(READER, PROJECT, "member");
  }, 180_000);

  afterAll(async () => {
    try {
      await Promise.all([...liveLabs].map((lab) => lab.stop()));
    } finally {
      await harness?.close();
    }
    const summary = process.env.GITHUB_STEP_SUMMARY;
    if (summary) {
      appendFileSync(
        summary,
        `### Orders lab on the MCP Python SDK (synthetic ids)\n\n\`\`\`json\n${JSON.stringify(evidence, null, 2)}\n\`\`\`\n`,
      );
    }
  }, 40_000);

  it.skipIf(!PYTHON)(
    "flags the broken refund, a protocol error, a tool error and a rejected request",
    async () => {
      const lab = await startLab(["--release", "broken", "--outcomes", "on"]);
      const call = await connect(lab.url, "claude-code");
      await call("reset_orders");
      const refund = await call("refund_order", {
        order_id: "1042",
        reason: "damaged in transit",
      });
      expect(refund?.result?.isError).toBeFalsy();
      // The broken release answers "refunded" and leaves the order paid.
      const stored = await (await fetch(`${lab.url}/orders/1042`)).json();
      expect(stored.status).toBe("paid");
      expect((await call("get_order", { order_id: "9001" }))?.error?.code).toBe(
        -32603,
      );
      expect(
        (await call("get_order", { order_id: "9002" }))?.result?.isError,
      ).toBe(true);
      expect((await call("get_order", { order_id: "1042\n" }))?.error?.code).toBe(
        -32602,
      );
      const output = await lab.stop();
      expect(output).not.toContain(harness.writer);

      const counts = await read("counts", { serviceName: lab.service });
      expect(counts).toMatchObject({
        received: 5,
        evaluated: 1,
        unmeasured: 4,
        flagged: {
          outcome_not_met: 1,
          protocol_error: 1,
          tool_error: 1,
          rejected_request: 1,
        },
      });
      const calls = await read("calls", { serviceName: lab.service });
      const refundCall = calls.items.find(
        (item: { toolName: string }) => item.toolName === "refund_order",
      );
      expect(refundCall).toMatchObject({
        clientName: "claude-code",
        serviceVersion: "1.0.0-broken",
        outcomes: [{ name: "refund_committed", status: "not_met" }],
      });
      evidence.broken = { counts, refund: refundCall };
    },
    90_000,
  );

  it.skipIf(!PYTHON)(
    "reads met on the fixed release and unmeasured with the reporter off",
    async () => {
      const fixed = await startLab(["--release", "fixed", "--outcomes", "on"]);
      const silent = await startLab(["--release", "broken", "--outcomes", "off"]);
      const staging = await startLab(["--environment", "staging"]);
      for (const lab of [fixed, silent, staging]) {
        const call = await connect(lab.url, "codex");
        await call("reset_orders");
        await call("refund_order", { order_id: "1042", reason: "duplicate" });
      }
      expect((await (await fetch(`${fixed.url}/orders/1042`)).json()).status).toBe(
        "refunded",
      );
      for (const lab of [fixed, silent, staging]) await lab.stop();

      const fixedCalls = await read("calls", { serviceName: fixed.service });
      expect(
        fixedCalls.items.find(
          (item: { toolName: string }) => item.toolName === "refund_order",
        )?.outcomes,
      ).toEqual([{ name: "refund_committed", status: "met" }]);
      const silentCounts = await read("counts", { serviceName: silent.service });
      expect(silentCounts).toMatchObject({ received: 2, evaluated: 0, unmeasured: 2 });
      // A test copy reports deployment.environment.name=staging and stays out.
      const stagingCounts = await read("counts", { serviceName: staging.service });
      expect(stagingCounts.received).toBe(0);
      evidence.fixed = fixedCalls.items;
      evidence.reporterOff = silentCounts;
    },
    90_000,
  );
});
