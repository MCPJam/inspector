/**
 * Live, synthetic smoke: node --import tsx scripts/verify-network-diagnostics.ts
 * Requires only E2B_API_KEY and GITHUB_CHECKS_E2B_TEMPLATE_ID. No app env loader.
 * Uses the real provisioning/monitor/cleanup path; never clones customer code.
 */
import { writeFile } from "node:fs/promises";
import { Sandbox } from "e2b";
import { logger } from "../server/utils/logger.js";
import {
  provisionCheckSandbox,
  killCheckSandbox,
  type CheckSandbox,
} from "../server/services/github-checks/sandbox.js";

const rows: { message: string; context?: Record<string, unknown> }[] = [];
// Keep synthetic logs local: exercise the production call sites without
// sending smoke records into an operator's configured telemetry sink.
logger.info = (message, context) => {
  rows.push({ message, context });
};
logger.warn = (message, context) => {
  rows.push({ message, context });
};
const report: Record<string, unknown> = { startedAt: new Date().toISOString() };
let sandbox: CheckSandbox | undefined;
try {
  sandbox = await provisionCheckSandbox({
    triggerId: "synthetic-network-smoke",
    repoFullName: "synthetic/network-probe",
    prNumber: 0,
  });
  report.sandboxId = sandbox.sandboxId;
  await sandbox.commands.run(
    "git -c credential.helper= clone --depth 1 --no-checkout https://github.com/octocat/Hello-World.git /tmp/network-smoke-clone >/dev/null 2>&1",
    { timeoutMs: 40_000 },
  );
  await sandbox.commands.run(
    "npm install --prefix /tmp/network-smoke-package --cache /tmp/network-smoke-package/cache --ignore-scripts --package-lock=false --no-audit --no-fund is-number@7.0.0 >/dev/null 2>&1",
    { timeoutMs: 40_000 },
  );
  report.buildDependencies = true;
  // The sentinel is request text. It must never appear in network diagnostics.
  await sandbox.commands.run(
    "curl --noproxy '*' -fsS -o /dev/null --max-time 10 -H 'X-Probe: NETWORK-SECRET-SENTINEL' https://example.com/",
    { timeoutMs: 15_000 },
  );
  // At least one heartbeat also exercises kernel packet-loss accounting.
  await new Promise((resolve) => setTimeout(resolve, 11_000));
  report.started = rows.some((r) =>
    r.message.endsWith("network monitor started"),
  );
  report.attempt = rows.some((r) => r.context?.outcome === "attempted");
  report.reply = rows.some((r) => r.context?.outcome === "syn_ack_observed");
  report.identity = rows
    .filter((r) => r.context?.outcome)
    .every(
      (r) =>
        r.context?.sandboxId === sandbox!.sandboxId &&
        r.context?.triggerId === "synthetic-network-smoke",
    );
  report.redaction = !JSON.stringify(rows).includes("NETWORK-SECRET-SENTINEL");
  report.monitorHealthy = !rows.some((r) => r.context?.reason);
} catch {
  report.error = "smoke_failed";
} finally {
  await killCheckSandbox(sandbox ?? null);
  try {
    report.cleanup =
      sandbox && !(await (sandbox as unknown as Sandbox).isRunning())
        ? "verified_stopped"
        : "failed";
  } catch {
    report.cleanup = "inconclusive";
  }
  report.rows = rows;
  report.finishedAt = new Date().toISOString();
  if (process.env.NETWORK_SMOKE_REPORT)
    await writeFile(
      process.env.NETWORK_SMOKE_REPORT,
      JSON.stringify(report, null, 2) + "\n",
    );
  process.stdout.write(JSON.stringify(report, null, 2) + "\n");
  process.exitCode =
    [
      report.buildDependencies,
      report.started,
      report.attempt,
      report.reply,
      report.identity,
      report.redaction,
      report.monitorHealthy,
    ].every((v) => v === true) &&
    report.cleanup === "verified_stopped" &&
    !report.error
      ? 0
      : 1;
}
