import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";
import { sourceRevision } from "../scripts/jamroom-source.mjs";

const [envPath, fixturePath] = process.argv.slice(2);
if (!envPath || !fixturePath) {
  throw new Error("Pass a Jamroom agent env file and a JSON fixture with suite, case, server, account IDs, and expected whoami identities.");
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
const { viewerIdentity, auditorIdentity, adminIdentity, supportIdentity } = fixture;
for (const value of [viewerIdentity, auditorIdentity, adminIdentity, supportIdentity]) {
  assert(typeof value === "string" && value.length > 0, "Missing expected whoami identity.");
}

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
    headers: { authorization: "Bearer " + apiKey, "content-type": "application/json", connection: "close" },
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: "error",
    signal: AbortSignal.timeout(90_000),
  });
  assert(response.ok, method + " " + route + " returned HTTP " + response.status);
  return response.json();
}

function cliJson(args) {
  const response = spawnSync(process.execPath, [cli, "--format", "json", "--timeout", "90000", ...args], {
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
  const iterations = path + "/eval-runs/" + runId + "/iterations";
  const { items } = await request(iterations);
  assert.equal(items.length, selectedCases.length, label + " iteration count");
  for (const item of items) {
    const { items: steps } = await request(iterations + "/" + item.id + "/steps");
    assert.deepEqual(steps.map(({ kind, status }) => [kind, status]), [
      ["toolCall", "ok"], ["assert", "ok"],
      ["toolCall", "ok"], ["assert", "ok"],
    ], label + " pinned whoami assertions");
  }
  return { surface: label, runId };
}

function setIdentityAssertions(caseId, billingIdentity) {
  const call = (serverName, needle) => [
    { id: serverName + "-whoami", kind: "toolCall", toolName: "whoami", serverName, arguments: {} },
    { id: serverName + "-identity", kind: "assert", assertion: { type: "toolResultContains", toolName: "whoami", needle } },
  ];
  return request(suitePath + "/cases/" + caseId, "PATCH", {
    steps: [...call("Billing", billingIdentity), ...call("CRM", supportIdentity)],
  });
}

async function checkProtectedMessage() {
  const { id, allowedText, deniedText } = fixture.protectedMessage;
  for (const value of [id, allowedText, deniedText]) {
    assert(typeof value === "string" && value.length > 0, "Missing protected message fixture.");
  }
  assert.notEqual(allowedText, deniedText);
  const cases = [
    { caseId: fixture.inheritedCaseId, identity: viewerIdentity, expected: deniedText },
    { caseId: fixture.pinnedCaseId, identity: adminIdentity, expected: allowedText },
  ];
  for (const { caseId, identity, expected } of cases) {
    await request(suitePath + "/cases/" + caseId, "PATCH", {
      steps: [
        { id: "whoami", kind: "toolCall", toolName: "whoami", serverName: "Billing", arguments: {} },
        { id: "identity", kind: "assert", assertion: { type: "toolResultContains", toolName: "whoami", needle: identity } },
        { id: "read", kind: "toolCall", toolName: "read_message", serverName: "Billing", arguments: { id } },
        { id: "access", kind: "assert", assertion: { type: "toolResultContains", toolName: "read_message", needle: expected } },
      ],
    });
  }
  return check("REST protected message allow and deny", (await launch()).runId, viewer);
}

await request(suitePath, "PATCH", { accounts: [viewer, support] });
await request(suitePath + "/cases/" + fixture.pinnedCaseId, "PATCH", { accounts: [admin] });
await setIdentityAssertions(fixture.inheritedCaseId, auditorIdentity);
await setIdentityAssertions(fixture.pinnedCaseId, adminIdentity);
const results = [];
const launch = (accounts) => request(path + "/eval-runs", "POST", {
  suiteId: fixture.suiteId,
  caseIds: cases,
  idempotencyKey: randomUUID(),
  ...(accounts ? { accounts } : {}),
});
const fromMcp = mcpCall("run_eval_suite", {
  project: projectId, suite: fixture.suiteId, cases,
  accounts: [auditor], idempotencyKey: randomUUID(),
});
const single = mcpCall("run_eval_case", {
  project: projectId, suite: fixture.suiteId, case: fixture.pinnedCaseId,
  accounts: [auditor], idempotencyKey: randomUUID(),
});
const rest = await launch([auditor]);
const fromCli = cliJson([
  "cloud", "eval", "run", "--suite", fixture.suiteId, "--project", projectId,
  "--account", auditor.serverId + "=" + auditor.accountId, "--api-url", apiUrl,
]);
results.push(await check("REST", rest.runId, auditor));
results.push(await check("CLI suite", fromCli.runId, auditor));
results.push(await check("MCP suite", fromMcp.runId, auditor));
results.push(await check("MCP case", single.runId, auditor, [fixture.pinnedCaseId]));
await setIdentityAssertions(fixture.inheritedCaseId, viewerIdentity);
results.push(await check("REST saved choices after overrides", (await launch()).runId, viewer));
if (fixture.protectedMessage) results.push(await checkProtectedMessage());
console.log(JSON.stringify({ inspector: env.JAMROOM_INSPECTOR_COMMIT, results }));
