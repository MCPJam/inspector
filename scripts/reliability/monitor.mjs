import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import {
  parseFixtures,
  runJourneys,
  safeBaseUrl,
} from "./critical-journeys.mjs";

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
export const safeVersion = (value) =>
  typeof value === "string" && /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(value)
    ? value
    : null;

// Sentry's ingestion endpoint accepts a check_in envelope. Upsert the monitor
// on every run, so missing executions can be detected outside GitHub Actions.
export async function heartbeat(
  status,
  { dsnValue = process.env.CANARY_SENTRY_DSN, fetchImpl = fetch } = {}
) {
  const dsn = new URL(dsnValue);
  if (
    dsn.protocol !== "https:" ||
    (!dsn.hostname.endsWith(".ingest.us.sentry.io") &&
      !dsn.hostname.endsWith(".ingest.sentry.io"))
  )
    throw new Error("Invalid Sentry DSN");
  const project = dsn.pathname.slice(1);
  if (!/^\d+$/.test(project) || !dsn.username)
    throw new Error("Invalid Sentry project");
  const checkin = {
    check_in_id: randomUUID().replaceAll("-", ""),
    monitor_slug: "inspector-critical-journeys",
    status,
    environment: "prod",
    monitor_config: {
      schedule: { type: "crontab", value: "*/5 * * * *" },
      timezone: "UTC",
      checkin_margin: 10,
      max_runtime: 10,
      failure_issue_threshold: 1,
      recovery_threshold: 1,
    },
  };
  const response = await fetchImpl(
    `https://${dsn.host}/api/${project}/envelope/`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/x-sentry-envelope",
        "X-Sentry-Auth": `Sentry sentry_version=7,sentry_key=${dsn.username},sentry_client=mcpjam-canary/1`,
      },
      body: `${JSON.stringify({
        dsn: dsn.href,
        sent_at: new Date().toISOString(),
      })}\n${JSON.stringify({ type: "check_in" })}\n${JSON.stringify(
        checkin
      )}\n`,
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
    }
  );
  if (!response.ok) throw new Error("Heartbeat rejected");
}

function install(directory) {
  return new Promise((resolve) => {
    // Install lifecycle scripts are part of the actual npm user experience.
    // They get no canary credentials, Slack webhook or Sentry DSN.
    const process = spawn(
      "npm",
      [
        "install",
        "--prefix",
        directory,
        "--omit=dev",
        "--legacy-peer-deps",
        "--no-audit",
        "--no-fund",
        "@mcpjam/inspector@latest",
      ],
      {
        env: { PATH: globalThis.process.env.PATH, HOME: directory, CI: "true" },
        stdio: "ignore",
        timeout: 180_000,
      }
    );
    process.on("error", () => resolve(false));
    process.on("exit", (code) => resolve(code === 0));
  });
}

export async function runMonitor() {
  const results = [];
  const record = (name, passed, status = 0) =>
    results.push({ name, outcome: passed ? "passed" : "failed", status });
  let coverageFailure = false;
  let directory;
  let child;
  const versions = { hosted: null, npm: null };
  try {
    const baseUrl = safeBaseUrl(
      process.env.CANARY_BASE_URL || "https://app.mcpjam.com"
    );
    // Health checks remain useful even when authenticated configuration is absent.
    for (const endpoint of ["/health", "/api/mcp/health", "/api/apps/health"]) {
      let response;
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          response = await fetch(`${baseUrl}${endpoint}`, {
            redirect: "error",
            signal: AbortSignal.timeout(15_000),
          });
        } catch {
          response = undefined;
        }
        if (response?.ok) break;
      }
      record(`hosted${endpoint}`, !!response?.ok, response?.status);
      if (endpoint === "/health" && response?.ok) {
        try {
          versions.hosted = safeVersion((await response.json()).version);
        } catch {
          /* unavailable version */
        }
      }
    }
    const apiKey = process.env.CANARY_API_KEY;
    const fixtures = parseFixtures(process.env.CANARY_FIXTURES_JSON);
    if (!apiKey) throw new Error("Missing canary credential");
    const hosted = await runJourneys({ baseUrl, apiKey, fixtures });
    results.push(
      ...hosted.results.map((r) => ({ ...r, name: `hosted.${r.name}` }))
    );

    directory = await mkdtemp(path.join(tmpdir(), "mcpjam-production-canary-"));
    const installed = await install(directory);
    record("npm.install", installed);
    if (installed) {
      versions.npm = safeVersion(
        JSON.parse(
          await readFile(
            path.join(directory, "node_modules/@mcpjam/inspector/package.json"),
            "utf8"
          )
        ).version
      );
      const port = 6274;
      child = spawn(
        globalThis.process.execPath,
        [
          path.join(directory, "node_modules/@mcpjam/inspector/bin/start.js"),
          "--port",
          String(port),
        ],
        {
          detached: true,
          stdio: "ignore",
          env: {
            PATH: process.env.PATH,
            HOME: directory,
            CI: "true",
            MCPJAM_INSPECTOR_DISABLE_ORPHAN_CHECK: "1",
            MCPJAM_INSPECTOR_SUPPRESS_AUTO_OPEN: "1",
            DO_NOT_TRACK: "1",
          },
        }
      );
      child.on("error", () => {});
      let ready = false;
      for (let attempt = 0; attempt < 30; attempt++) {
        if (child.exitCode !== null) break;
        try {
          ready = (
            await fetch(`http://127.0.0.1:${port}/health`, {
              signal: AbortSignal.timeout(1000),
            })
          ).ok;
        } catch {
          /* booting */
        }
        if (ready) break;
        await pause(1000);
      }
      record("npm.startup", ready);
      if (ready) {
        const local = await runJourneys({
          baseUrl: `http://127.0.0.1:${port}`,
          apiKey,
          localBearer: process.env.CANARY_LOCAL_BEARER,
          fixtures,
          mode: "local",
        });
        results.push(
          ...local.results.map((r) => ({ ...r, name: `npm.${r.name}` }))
        );
      }
    }
  } catch {
    coverageFailure = true;
  } finally {
    if (child?.pid) {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        /* exited */
      }
    }
    if (directory) {
      try {
        await rm(directory, { recursive: true, force: true });
      } catch {
        record("monitor.cleanup", false);
      }
    }
    if (process.env.SLACK_ALERTS_CONFIGURED !== "true")
      record("monitor.slack-configuration", false);
    try {
      await heartbeat(
        coverageFailure || results.some((r) => r.outcome !== "passed")
          ? "error"
          : "ok"
      );
      record("monitor.heartbeat", true);
    } catch {
      record("monitor.heartbeat", false);
    }
    const report = {
      schemaVersion: 1,
      checkedAt: new Date().toISOString(),
      passed:
        !coverageFailure &&
        results.length > 0 &&
        results.every((r) => r.outcome === "passed"),
      coverageFailure,
      versions,
      results,
    };
    await writeFile("reliability-report.json", JSON.stringify(report, null, 2));
    process.stdout.write(
      `${report.passed ? "PASS" : "FAIL"}: ${results
        .map((r) => `${r.name}=${r.outcome}`)
        .join(", ")}\n`
    );
    process.exitCode = report.passed ? 0 : 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  await runMonitor();
