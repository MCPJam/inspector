import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";
import { sourceRevision } from "./jamroom-source.mjs";

const envPath = process.argv[2];
if (!envPath) throw new Error("Pass the agent env file printed by qa:start --agent-api.");
const env = parseEnv(readFileSync(envPath, "utf8"));
const {
  MCPJAM_API_URL: apiUrl, MCPJAM_API_KEY: apiKey, MCPJAM_CLI: cli,
  JAMROOM_MCP_URL: mcpUrl, JAMROOM_MCP_CREDENTIALS: credentials,
  JAMROOM_PROJECT_ID: projectId,
} = env;

function localEndpoint(url, path) {
  const parsed = new URL(url);
  assert.equal(parsed.protocol, "http:");
  assert.equal(parsed.hostname, "localhost");
  assert(parsed.port && parsed.pathname === path);
  assert(!parsed.username && !parsed.password && !parsed.search && !parsed.hash);
}

localEndpoint(apiUrl, "/api/v1");
localEndpoint(mcpUrl, "/mcp");
assert.equal(realpathSync(cli), realpathSync(fileURLToPath(new URL("../dist/index.js", import.meta.url))));
assert(/^sk_[\w-]+$/.test(apiKey), "A Jamroom customer key is required.");
assert(/^[a-zA-Z0-9]+$/.test(projectId));
const checkout = fileURLToPath(new URL("../../", import.meta.url));

function verifySource() {
  assert.deepEqual(sourceRevision(checkout), {
    commit: env.JAMROOM_INSPECTOR_COMMIT,
    snapshot: env.JAMROOM_INSPECTOR_SNAPSHOT,
  }, "The Inspector source changed. Run qa:start again.");
}
verifySource();

const childEnv = { ...process.env, MCPJAM_API_KEY: apiKey, MCPJAM_API_URL: apiUrl };
delete childEnv.MCPJAM_BASE_URL;
const audience = [];
function runCli(args, cloud = false) {
  const run = spawnSync(process.execPath, [cli, "--format", "json", ...args], {
    env: childEnv, encoding: "utf8", timeout: 120_000, maxBuffer: 8 * 1024 * 1024,
  });
  if (run.error) throw run.error;
  if (run.status !== 0) throw new Error("CLI " + args.slice(0, 3).join(" ") + " exited with " + run.status);
  if (cloud) {
    const line = run.stderr.split("\n").find((line) => line.startsWith("Using MCPJam Cloud "));
    assert(line?.split(" · ").includes(apiUrl), "The CLI did not report the Jamroom API URL.");
    audience.push(line);
  }
  return JSON.parse(run.stdout);
}

async function api(path, options = {}) {
  const response = await fetch(apiUrl + path, {
    method: options.method,
    headers: { authorization: "Bearer " + apiKey, "content-type": "application/json" },
    body: options.body && JSON.stringify(options.body),
    redirect: "error",
    signal: AbortSignal.timeout(300_000),
  });
  const result = await response.json();
  if (!response.ok) {
    const reason = [result.code, result.details?.reason, result.message].filter(Boolean).join(" / ");
    throw new Error((options.method ?? "GET") + " " + path + " returned HTTP " + response.status + " (" + reason + ").");
  }
  return result;
}

const listed = runCli([
  "tools", "call", "--url", mcpUrl, "--credentials-file", credentials,
  "--tool-name", "list_projects", "--tool-args", "{}",
]);
assert(listed.structuredContent?.items?.some(({ id }) => id === projectId),
  "The local MCP Worker did not discover the seeded Jamroom project.");

const projectPath = "/projects/" + projectId;
const { items } = await api(projectPath + "/servers");
const server = items.find(({ name, url }) =>
  name === "stateless" && url === "https://stateless.mcpjam.com/mcp");
assert(server?.id, "The Jamroom echo fixture is missing.");

const marker = "jamroom-" + randomUUID();
const client = await api(projectPath + "/clients", {
  method: "POST", body: { name: marker, template: "claude-code" },
});
assert(client.id && client.configId, "The Claude Code fixture has no configuration revision.");
const clientPath = projectPath + "/clients/" + encodeURIComponent(client.id);
const configured = await api(clientPath, {
  method: "PATCH",
  body: { expectedConfigId: client.configId, set: { requireToolApproval: false } },
});
assert(configured.configId, "The configured client has no revision.");
await api(clientPath + "/servers", {
  method: "POST",
  body: { expectedConfigId: configured.configId, serverIds: [server.id] },
});
const turn = await api("/chat-sessions/messages", {
  method: "POST",
  body: {
    projectId, hostId: client.id, allowedServerIds: [server.id],
    message: 'Call the stateless server’s echo tool with the literal text "' + marker + '".',
    toolMode: "auto", idempotencyKey: marker,
  },
});
assert.equal(turn.engine, "harness:claude-code", "The real Claude Code runtime did not run.");
assert.equal(turn.projectId, projectId);
assert(turn.sessionId && turn.turnId);
const target = ["--api-url", apiUrl, "--project", projectId, "--session", turn.sessionId];
const trace = runCli(["cloud", "sessions", "trace", ...target, "--turn", turn.turnId], true);
assert.equal(trace.projectId, projectId);
assert.equal(trace.sessionId, turn.sessionId);
const transcript = runCli(["cloud", "sessions", "show", ...target, "--limit", "200"], true);
assert.equal(transcript.projectId, projectId);
assert.equal(transcript.sessionId, turn.sessionId);

const parts = (role) => transcript.messages
  .filter((message) => message.role === role && Array.isArray(message.content))
  .flatMap((message) => message.content);
const echo = parts("assistant").find((part) =>
  part.type === "tool-call" && part.toolName === "echo" &&
  part.input?.message === marker);
assert(echo?.toolCallId, "The persisted transcript did not contain the echo call.");
const span = trace.turns?.find(({ turnId }) => turnId === turn.turnId)
  ?.spans?.find(({ toolCallId, status }) => toolCallId === echo.toolCallId && status === "ok");
assert(span, "The checkout CLI trace did not contain the successful echo call.");
const result = parts("tool").find((part) =>
  part.type === "tool-result" && part.toolCallId === echo.toolCallId &&
  part.output?.type === "json" && part.output.value?.structuredContent?.echoed === marker);
assert(result, "The persisted echo result did not match the input.");

verifySource();
process.stdout.write(JSON.stringify({
  apiUrl, mcpUrl, projectId, engine: turn.engine,
  inspectorCommit: env.JAMROOM_INSPECTOR_COMMIT,
  inspectorSnapshot: env.JAMROOM_INSPECTOR_SNAPSHOT,
  backendCommit: env.JAMROOM_BACKEND_COMMIT,
  backendSnapshot: env.JAMROOM_BACKEND_SNAPSHOT,
  sessionId: turn.sessionId, turnId: turn.turnId, toolCallId: echo.toolCallId,
  echoed: result.output.value.structuredContent.echoed, audience,
}, null, 2) + "\n");
