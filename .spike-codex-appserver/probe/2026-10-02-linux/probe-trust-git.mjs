// A cwd INSIDE a git repo whose root carries the planted config: which path
// does codex trust, and does seeding the cwd alone keep the root's config out?
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createFake, freshDirs, renderConfig, startAppServer, HERE } from "./lib.mjs";
const MCP = join(HERE, "mcp-server.mjs");
const q = JSON.stringify;
async function run(name, seedPaths) {
  const d = freshDirs(`trustgit-${name}`);
  const repo = join(d.root, "repo"); const cwd = join(repo, "sub");
  mkdirSync(join(repo, ".codex"), { recursive: true }); mkdirSync(cwd, { recursive: true });
  execFileSync("git", ["init", "-q", repo]);
  const mcpLog = join(d.root, "spawn.ndjson"); writeFileSync(mcpLog, "");
  writeFileSync(join(repo, ".codex", "config.toml"),
    `[mcp_servers.root_planted]\ncommand = ${q(process.execPath)}\nargs = [${q(MCP)}]\n[mcp_servers.root_planted.env]\nMCP_NAME = "root_planted"\nMCP_LOG = ${q(mcpLog)}\n`);
  const fake = createFake({ script: [{ text: "ok" }], logPath: join(d.root, "http.ndjson") });
  const origin = await fake.listen();
  const paths = { cwd, repo };
  const extra = seedPaths.map((k) => `[projects.${q(paths[k])}]\ntrust_level = "untrusted"`).join("\n");
  writeFileSync(join(d.codexHome, "config.toml"), renderConfig({ baseUrl: `${origin}/v1`, extra }));
  const app = startAppServer({ codexHome: d.codexHome, cwd, home: d.home, env: { TMPDIR: d.tmp }, logPath: join(d.root, "rpc.ndjson") });
  const r = { name, seeded: seedPaths };
  try { await app.init(); await app.request("thread/start", { cwd, approvalPolicy: "untrusted", sandbox: "workspace-write" }, 30_000); await new Promise((ok) => setTimeout(ok, 2500)); }
  catch (e) { r.error = e.message.slice(0, 200); } finally { await app.close(); await fake.close(); }
  const after = readFileSync(join(d.codexHome, "config.toml"), "utf8");
  r.trustEntries = [...after.matchAll(/\[projects\.("[^"]+")\]\s*\ntrust_level\s*=\s*"([^"]+)"/g)].map((m) => `${JSON.parse(m[1]).endsWith("/sub") ? "cwd" : "repo"}=${m[2]}`);
  r.rootServerSpawned = readFileSync(mcpLog, "utf8").includes("root_planted");
  console.log(JSON.stringify(r));
}
await run("no-seed", []);
await run("seed-cwd", ["cwd"]);
await run("seed-repo", ["repo"]);
await run("seed-both", ["cwd", "repo"]);
