import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";
import { sourceRevision } from "./jamroom-source.mjs";

const [envPath, fixturePath] = process.argv.slice(2);
if (!envPath || !fixturePath) {
  throw new Error("Pass a Jamroom agent env file and a JSON fixture with suite, case, server, and account IDs.");
}
const env = parseEnv(readFileSync(envPath, "utf8"));
const fixture = JSON.parse(readFileSync(fixturePath, "utf8"));
const {
  MCPJAM_API_URL: apiUrl, MCPJAM_API_KEY: apiKey, MCPJAM_CLI: cli,
  JAMROOM_MCP_URL: mcpUrl, JAMROOM_MCP_CREDENTIALS: credentials,
  JAMROOM_PROJECT_ID: projectId,
} = env;
for (const [endpoint, pathname] of [[apiUrl, "/api/v1"], [mcpUrl, "/mcp"]]) {
  const url = new URL(endpoint);
  assert(url.protocol === "http:" && url.hostname === "localhost" && url.port);
  assert.equal(url.pathname, pathname);
  assert(!url.username && !url.password && !url.search && !url.hash);
}
assert.equal(realpathSync(cli), realpathSync(fileURLToPath(new URL("../dist/index.js", import.meta.url))));
assert.deepEqual(sourceRevision(fileURLToPath(new URL("../../", import.meta.url))), {
  commit: env.JAMROOM_INSPECTOR_COMMIT,
  snapshot: env.JAMROOM_INSPECTOR_SNAPSHOT,
});
assert(/^sk_[\w-]+$/.test(apiKey));
for (const value of [
  projectId, fixture.suiteId, fixture.inheritedCaseId, fixture.pinnedCaseId,
  fixture.billingServerId, fixture.crmServerId, fixture.viewerAccountId,
  fixture.auditorAccountId, fixture.adminAccountId, fixture.supportAccountId,
]) assert(/^[a-z0-9]+$/i.test(value ?? ""), "Invalid fixture ID.");

const path = "/projects/" + projectId;
const suitePath = path + "/eval-suites/" + fixture.suiteId;
const account = (serverId, accountId) => ({ serverId, accountId });
const viewer = account(fixture.billingServerId, fixture.viewerAccountId);
const auditor = account(fixture.billingServerId, fixture.auditorAccountId);
const admin = account(fixture.billingServerId, fixture.adminAccountId);
const support = account(fixture.crmServerId, fixture.supportAccountId);
const cases = [fixture.inheritedCaseId, fixture.pinnedCaseId];
const childEnv = { ...process.env, MCPJAM_API_KEY: apiKey, MCPJAM_API_URL: apiUrl };
delete childEnv.MCPJAM_BASE_URL;

async function request(route, method = "GET", body) {
  const response = await fetch(apiUrl + route, {
    method,
    headers: { authorization: "Bearer " + apiKey, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: "error",
    signal: AbortSignal.timeout(30_000),
  });
  assert(response.ok, method + " " + route + " returned HTTP " + response.status);
  return response.json();
}

function cliJson(args) {
  const response = spawnSync(process.execPath, [cli, "--format", "json", ...args], {
    env: childEnv, encoding: "utf8", timeout: 120_000, maxBuffer: 8 * 1024 * 1024,
  });
  if (response.error) throw response.error;
  assert.equal(response.status, 0, "Jamroom CLI command failed");
  return JSON.parse(response.stdout);
}

function mcpCall(tool, args) {
  const result = cliJson([
    "tools", "call", "--url", mcpUrl, "--credentials-file", credentials,
    "--tool-name", tool, "--tool-args", JSON.stringify(args),
  ]);
  assert(!result.isError, "Jamroom MCP tool returned an error");
  return result.structuredContent;
}

async function check(label, runId, billing, selectedCases = cases) {
  assert(runId, label + " did not return a run ID");
  let run;
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    run = await request(path + "/eval-runs/" + runId);
    if (["completed", "failed", "cancelled", "timed_out"].includes(run.status)) break;
    await new Promise((resolve) => setTimeout(resolve, 1500));
  }
  assert.equal(run.status, "completed", label);
  const observed = run.accounts.flatMap((entry) => (entry.cases ?? []).map((test) => ({
    testCaseId: test.testCaseId, serverId: entry.serverId, accountId: entry.accountId,
    source: test.source,
  })));
  const expected = selectedCases.flatMap((testCaseId) => [
    { testCaseId, ...support, source: "suite" },
    testCaseId === fixture.pinnedCaseId
      ? { testCaseId, ...admin, source: "case" }
      : { testCaseId, ...billing, source: billing === auditor ? "run" : "suite" },
  ]);
  const sorted = (rows) => rows.map((row) =>
    [row.testCaseId, row.serverId, row.accountId, row.source].join(":")).sort();
  assert.deepEqual(sorted(observed), sorted(expected), label);
  return { surface: label, runId };
}

await request(suitePath, "PATCH", { accounts: [viewer, support] });
await request(suitePath + "/cases/" + fixture.pinnedCaseId, "PATCH", { accounts: [admin] });
const results = [];
const launch = (accounts) => request(path + "/eval-runs", "POST", {
  suiteId: fixture.suiteId,
  caseIds: cases,
  serverIds: [viewer.serverId, support.serverId],
  idempotencyKey: randomUUID(),
  ...(accounts ? { accounts } : {}),
});
results.push(await check("REST", (await launch([auditor])).runId, auditor));
const fromCli = cliJson([
  "eval", "run", "--suite", fixture.suiteId, "--project", projectId,
  "--account", auditor.serverId + "=" + auditor.accountId, "--api-url", apiUrl,
]);
results.push(await check("CLI suite", fromCli.runId, auditor));
const fromMcp = mcpCall("run_eval_suite", {
  project: projectId, suite: fixture.suiteId, cases,
  accounts: [auditor], idempotencyKey: randomUUID(),
});
results.push(await check("MCP suite", fromMcp.runId, auditor));
const single = mcpCall("run_eval_case", {
  project: projectId, suite: fixture.suiteId, case: fixture.pinnedCaseId,
  accounts: [auditor], idempotencyKey: randomUUID(),
});
results.push(await check("MCP case", single.runId, auditor, [fixture.pinnedCaseId]));
results.push(await check("REST saved choices after overrides", (await launch()).runId, viewer));
console.log(JSON.stringify({ inspector: env.JAMROOM_INSPECTOR_COMMIT, results }));
