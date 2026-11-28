/**
 * The production traffic API over HTTP, on a real ClickHouse: admins manage
 * producer credentials and the ingest switch, members read counts and calls,
 * and the hosted smoke command runs end to end against the registered app.
 * Convex is a stand-in speaking the real client protocol (support/fake-convex.ts).
 *
 * Runs in the Production traffic workflow; skips elsewhere unless a
 * ClickHouse test target is configured (support/clickhouse-sandbox.ts).
 */
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { appendFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { clickHouseTestTarget } from "./support/clickhouse-sandbox.js";
import {
  OTHER_PROJECT,
  PROJECT,
  startReceiverHarness,
  type ReceiverHarness,
} from "./support/receiver-harness.js";

const SMOKE = resolve(
  __dirname,
  "../../../../scripts/production-traffic/smoke.mjs",
);
const PYTHON = process.env.PRODUCTION_TRAFFIC_TEST_PYTHON;
const hex = (bytes: number) => randomBytes(bytes).toString("hex");
const ADMIN = `admin.${hex(12)}`;
const READER = `reader.${hex(12)}`;
const OUTSIDER = `outsider.${hex(12)}`;

const batch = (serviceName: string) =>
  JSON.stringify({
    resourceSpans: [
      {
        resource: {
          attributes: [
            { key: "service.name", value: { stringValue: serviceName } },
          ],
        },
        scopeSpans: [
          {
            spans: [
              {
                traceId: hex(16),
                spanId: hex(8),
                name: "tools/call get_order",
                kind: 2,
                startTimeUnixNano: String(
                  BigInt(Date.now() - 1_000) * 1_000_000n,
                ),
                endTimeUnixNano: String(BigInt(Date.now() - 990) * 1_000_000n),
                attributes: [
                  {
                    key: "mcp.method.name",
                    value: { stringValue: "tools/call" },
                  },
                  {
                    key: "gen_ai.tool.name",
                    value: { stringValue: "get_order" },
                  },
                ],
              },
            ],
          },
        ],
      },
    ],
  });

/** Async on purpose: the app under test shares this process's event loop. */
function run(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv,
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((done) => {
    const child = spawn(command, args, { env });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("close", (status) => done({ status, stdout, stderr }));
  });
}

describe.skipIf(!clickHouseTestTarget())(
  "Production traffic API over HTTP",
  () => {
    let harness: ReceiverHarness;
    const evidence: Record<string, unknown> = {};

    const api = (
      path: string,
      bearer: string,
      init: { method?: string; body?: unknown } = {},
    ) =>
      fetch(`${harness.base}/api/v1/projects/${PROJECT}/production/${path}`, {
        method: init.method ?? "GET",
        headers: {
          Authorization: `Bearer ${bearer}`,
          ...(init.body === undefined
            ? {}
            : { "Content-Type": "application/json" }),
        },
        ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      });

    beforeAll(async () => {
      harness = await startReceiverHarness();
      harness.convex.addMember(ADMIN, PROJECT, "admin");
      harness.convex.addMember(READER, PROJECT, "member");
      harness.convex.addMember(OUTSIDER, OTHER_PROJECT, "member");
    }, 180_000);

    afterAll(async () => {
      await harness?.close();
      const summary = process.env.GITHUB_STEP_SUMMARY;
      if (summary) {
        appendFileSync(
          summary,
          `### Production traffic smoke command (synthetic ids)\n\n\`\`\`json\n${JSON.stringify(evidence, null, 2)}\n\`\`\`\n`,
        );
      }
    });

    it("lets an admin issue, use, rotate and revoke a credential, and switch ingest", async () => {
      const issued = await api("credentials", ADMIN, {
        method: "POST",
        body: { label: "orders-lab exporter" },
      });
      expect(issued.status).toBe(201);
      expect(issued.headers.get("cache-control")).toBe("no-store");
      const credential = await issued.json();
      expect(credential).toMatchObject({
        token: expect.stringMatching(/^mjotlp_[A-Za-z0-9_-]{43}$/),
        endpoint: `/api/v1/projects/${PROJECT}/otlp/v1/traces`,
      });
      expect(
        (await harness.post(batch("admin-flow"), { token: credential.token }))
          .status,
      ).toBe(200);

      const listed = await (await api("credentials", ADMIN)).json();
      expect(
        listed.credentials.map(
          (row: { credentialId: string }) => row.credentialId,
        ),
      ).toContain(credential.credentialId);

      const rotated = await api(
        `credentials/${credential.credentialId}/rotate`,
        ADMIN,
        {
          method: "POST",
          body: { overlapMinutes: 30 },
        },
      );
      expect(rotated.status).toBe(201);
      const replacement = await rotated.json();
      expect(
        (await harness.post(batch("admin-flow"), { token: replacement.token }))
          .status,
      ).toBe(200);

      const revoked = await api(
        `credentials/${replacement.credentialId}`,
        ADMIN,
        {
          method: "DELETE",
        },
      );
      expect(revoked.status).toBe(200);
      expect(
        (await harness.post(batch("admin-flow"), { token: replacement.token }))
          .status,
      ).toBe(401);

      const off = await api("ingest", ADMIN, {
        method: "PUT",
        body: { enabled: false },
      });
      expect(await off.json()).toEqual({ projectId: PROJECT, enabledAt: null });
      const refused = await harness.post(batch("admin-flow"));
      expect(refused.status).toBe(403);
      expect((await refused.json()).message).toMatch(/turn it on/);
      const on = await api("ingest", ADMIN, {
        method: "PUT",
        body: { enabled: true },
      });
      expect((await on.json()).enabledAt).toEqual(expect.any(Number));
      expect((await harness.post(batch("admin-flow"))).status).toBe(200);
    });

    it("refuses the wrong callers at the read and admin routes", async () => {
      expect((await api("counts", READER)).status).toBe(200);
      expect((await api("counts", harness.writer)).status).toBe(401);
      const outsider = await fetch(
        `${harness.base}/api/v1/projects/${PROJECT}/production/counts`,
        { headers: { Authorization: `Bearer ${OUTSIDER}` } },
      );
      expect(outsider.status).toBe(404);
      const memberIssue = await api("credentials", READER, {
        method: "POST",
        body: { label: "not an admin" },
      });
      expect(memberIssue.status).toBe(403);
      // A credential of another project cannot be reached through this one.
      const elsewhere = harness.convex.addCredential(
        `mjotlp_${hex(21)}x`,
        OTHER_PROJECT,
      );
      expect(
        (await api(`credentials/${elsewhere}`, ADMIN, { method: "DELETE" }))
          .status,
      ).toBe(404);
      expect(
        (
          await api("credentials", ADMIN, {
            method: "POST",
            body: { label: "" },
          })
        ).status,
      ).toBe(400);
    });

    it("runs the hosted smoke command end to end", async () => {
      const result = await run(
        process.execPath,
        [
          SMOKE,
          "--url",
          harness.base,
          "--project",
          PROJECT,
          ...(PYTHON ? ["--python", PYTHON] : []),
        ],
        {
          ...process.env,
          MCPJAM_PRODUCER_TOKEN: harness.writer,
          MCPJAM_READER_TOKEN: READER,
        },
      );
      expect(result.stdout).not.toContain(harness.writer);
      expect(result.stdout).not.toContain(READER);
      const report = JSON.parse(result.stdout);
      evidence.smoke = report;
      expect(
        report.checks.filter((check: { ok: boolean }) => !check.ok),
      ).toEqual([]);
      expect(result.status).toBe(0);
    }, 120_000);
  },
);
