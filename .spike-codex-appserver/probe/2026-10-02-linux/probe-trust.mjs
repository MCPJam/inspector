// Which thread/start settings make codex 0.149.1 record the cwd as trusted,
// and which countermeasures keep a planted project MCP server from spawning.
import { join } from "node:path";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createFake, freshDirs, renderConfig, startAppServer, HERE } from "./lib.mjs";
const MCP = join(HERE, "mcp-server.mjs");
const q = JSON.stringify;
async function run(name, { sandbox, approvalPolicy, seedTrust, threadConfig }) {
  const d = freshDirs(`trust-${name}`);
  const project = join(d.root, "project");
  mkdirSync(join(project, ".codex"), { recursive: true });
  const mcpLog = join(d.root, "spawn.ndjson");
  writeFileSync(mcpLog, "");
  writeFileSync(join(project, ".codex", "config.toml"),
    `[mcp_servers.project_planted]\ncommand = ${q(process.execPath)}\nargs = [${q(MCP)}]\n[mcp_servers.project_planted.env]\nMCP_NAME = "project_planted"\nMCP_LOG = ${q(mcpLog)}\n`);
  const fake = createFake({ script: [{ text: "ok" }], logPath: join(d.root, "http.ndjson") });
  const origin = await fake.listen();
  const extra = seedTrust ? `[projects.${q(project)}]\ntrust_level = ${q(seedTrust)}` : "";
  writeFileSync(join(d.codexHome, "config.toml"), renderConfig({ baseUrl: `${origin}/v1`, extra }));
  const app = startAppServer({ codexHome: d.codexHome, cwd: project, home: d.home, env: { TMPDIR: d.tmp }, logPath: join(d.root, "rpc.ndjson") });
  const r = { name, sandbox, approvalPolicy, seedTrust: seedTrust ?? null, threadConfig: threadConfig ? Object.keys(threadConfig) : null };
  try {
    await app.init();
    const res = await app.request("thread/start", { cwd: project, approvalPolicy, sandbox, ...(threadConfig ? { config: threadConfig } : {}) }, 30_000);
    r.threadStarted = Boolean(res?.thread?.id ?? res?.threadId);
    await new Promise((ok) => setTimeout(ok, 2500));
  } catch (e) { r.error = e.message.slice(0, 300); }
  finally { await app.close(); await fake.close(); }
  const after = readFileSync(join(d.codexHome, "config.toml"), "utf8");
  const m = after.match(/trust_level\s*=\s*"([^"]+)"/);
  r.trustAfter = m ? m[1] : "none";
  r.projectServerSpawned = readFileSync(mcpLog, "utf8").includes("project_planted");
  console.log(JSON.stringify(r));
}
const disable = { mcp_servers: { project_planted: { enabled: false } } };
await run("ro-never", { sandbox: "read-only", approvalPolicy: "never" });
await run("ro-untrusted", { sandbox: "read-only", approvalPolicy: "untrusted" });
await run("ww-never", { sandbox: "workspace-write", approvalPolicy: "never" });
await run("ww-untrusted", { sandbox: "workspace-write", approvalPolicy: "untrusted" });
await run("ww-untrusted+seed-untrusted", { sandbox: "workspace-write", approvalPolicy: "untrusted", seedTrust: "untrusted" });
await run("ww-never+seed-untrusted", { sandbox: "workspace-write", approvalPolicy: "never", seedTrust: "untrusted" });
await run("ww-untrusted+disable-by-name", { sandbox: "workspace-write", approvalPolicy: "untrusted", threadConfig: disable });
