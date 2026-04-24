import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  MCPAppsConformanceSuite,
  MCPConformanceSuite,
  renderConformanceReportJUnitXml,
  renderConformanceReportJson,
  toConformanceReport,
} from "@mcpjam/sdk";

const here = dirname(fileURLToPath(import.meta.url));
const reportsDir = join(here, "reports");
const port = 3102;
const serverUrl = `http://127.0.0.1:${port}/mcp`;
const healthUrl = `http://127.0.0.1:${port}/healthz`;

let serverProcess: ChildProcess | undefined;

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForHealthyServer(url: string): Promise<void> {
  const startedAt = Date.now();

  while (Date.now() - startedAt < 10_000) {
    try {
      const response = await fetch(url);
      if (response.ok) {
        return;
      }
    } catch {
      // Server is still starting.
    }

    await sleep(100);
  }

  throw new Error(`Timed out waiting for ${url}`);
}

beforeAll(async () => {
  serverProcess = spawn(process.execPath, [join(here, "mock-http-server.mjs")], {
    cwd: here,
    env: {
      ...process.env,
      PORT: String(port),
    },
    stdio: "inherit",
  });

  await waitForHealthyServer(healthUrl);
}, 15_000);

afterAll(async () => {
  if (
    !serverProcess ||
    serverProcess.killed ||
    serverProcess.exitCode !== null ||
    serverProcess.signalCode !== null
  ) {
    return;
  }

  await new Promise<void>((resolve) => {
    serverProcess?.once("exit", () => resolve());
    serverProcess?.kill("SIGTERM");
  });
}, 15_000);

it("runs protocol and apps conformance suites and writes shared reports", async () => {
  mkdirSync(reportsDir, { recursive: true });

  const protocolResult = await new MCPConformanceSuite({
    name: "Basic Protocol Suite",
    serverUrl,
    runs: [
      {
        label: "core-surface",
        checkIds: [
          "server-initialize",
          "ping",
          "tools-list",
          "prompts-list",
          "resources-list",
        ],
      },
    ],
  }).run();

  expect(protocolResult.passed).toBe(true);

  const appsResult = await new MCPAppsConformanceSuite({
    name: "Basic Apps Suite",
    target: {
      url: serverUrl,
      timeout: 10_000,
    },
    runs: [
      {
        label: "apps-surface",
      },
    ],
  }).run();

  expect(appsResult.passed).toBe(true);

  const protocolReport = toConformanceReport(protocolResult);
  const appsReport = toConformanceReport(appsResult);

  writeFileSync(
    join(reportsDir, "protocol-conformance.junit.xml"),
    renderConformanceReportJUnitXml(protocolReport),
  );
  writeFileSync(
    join(reportsDir, "protocol-conformance.report.json"),
    JSON.stringify(renderConformanceReportJson(protocolReport), null, 2),
  );
  writeFileSync(
    join(reportsDir, "apps-conformance.junit.xml"),
    renderConformanceReportJUnitXml(appsReport),
  );
  writeFileSync(
    join(reportsDir, "apps-conformance.report.json"),
    JSON.stringify(renderConformanceReportJson(appsReport), null, 2),
  );
}, 30_000);
