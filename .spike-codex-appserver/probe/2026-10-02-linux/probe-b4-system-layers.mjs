// Probe (b4): are system / managed config layers consulted, and can a thread
// override them?
//
// Plants (and afterwards REMOVES — /etc/codex did not exist before this probe):
//   /etc/codex/config.toml          [mcp_servers.etc_system]
//   /etc/codex/managed_config.toml  [mcp_servers.etc_managed]
//   /etc/codex/requirements.toml    allowed_approval_policies = ["untrusted","on-request"]
// then runs codex under strace (file-open syscalls) and records:
//   - config/read layers (+ disabledReason), configRequirements/read
//   - which planted servers spawn, with and without thread-level enabled=false
//   - whether thread/start{approvalPolicy:"never"} is refused under requirements.toml
//   - every path under /etc/codex, $HOME, CODEX_HOME, /root/.codex that codex opened/stat'ed
//
//   node probe-b4-system-layers.mjs
import { join } from "node:path";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createFake, freshDirs, renderConfig, startAppServer, toolNames, writeJson, HERE } from "./lib.mjs";

const MCP = join(HERE, "mcp-server.mjs");
const q = JSON.stringify;
if (existsSync("/etc/codex")) throw new Error("/etc/codex already exists; refusing to touch it");

const d = freshDirs("b4-system");
const mcpLog = join(d.root, "mcp-spawn.ndjson");
writeFileSync(mcpLog, "");
const server = (name) => [`command = ${q(process.execPath)}`, `args = [${q(MCP)}]`, "", `[mcp_servers.${name}.env]`, `MCP_NAME = ${q(name)}`, `MCP_LOG = ${q(mcpLog)}`].join("\n");

const results = {};
try {
  mkdirSync("/etc/codex");
  writeFileSync("/etc/codex/config.toml", `[mcp_servers.etc_system]\n${server("etc_system")}\n`);
  writeFileSync("/etc/codex/managed_config.toml", `[mcp_servers.etc_managed]\n${server("etc_managed")}\n`);
  writeFileSync("/etc/codex/requirements.toml", `allowed_approval_policies = ["untrusted", "on-request"]\n`);

  const run = async (label, threadParams) => {
    const fake = createFake({ script: [{ text: "ok" }], logPath: join(d.root, `${label}.http.ndjson`) });
    const origin = await fake.listen();
    writeFileSync(join(d.codexHome, "config.toml"), renderConfig({ baseUrl: `${origin}/v1` }));
    const strace = join(d.root, `${label}.strace.txt`);
    writeFileSync(mcpLog, "");
    const app = startAppServer({
      codexHome: d.codexHome,
      cwd: d.cwd,
      home: d.home,
      env: { TMPDIR: d.tmp },
      logPath: join(d.root, `${label}.rpc.ndjson`),
      wrapper: ["strace", "-f", "-qq", "-e", "trace=openat,open,stat,statx,newfstatat,lstat,access,faccessat,faccessat2,readlink,readlinkat", "-o", strace],
    });
    const r = {};
    try {
      await app.init();
      const cr = await app.request("config/read", { cwd: d.cwd, includeLayers: true }, 30_000);
      r.layers = (cr.layers ?? []).map((l) => ({ name: l.name, disabledReason: l.disabledReason ?? null, config: l.config }));
      r.effectiveMcpServers = Object.keys(cr.config?.mcp_servers ?? {});
      r.effectiveApprovalPolicy = cr.config?.approval_policy ?? null;
      try {
        r.configRequirements = await app.request("configRequirements/read", {}, 20_000);
      } catch (e) {
        r.configRequirements = { error: e.message.slice(0, 300) };
      }
      try {
        const t = await app.startThreadAndTurn({ threadParams: { cwd: d.cwd, sandbox: "read-only", ...threadParams }, prompt: "Say ok.", timeoutMs: 45_000 });
        r.threadStartResult = { approvalPolicy: t.thread.approvalPolicy, sandbox: t.thread.sandbox };
        r.turnStatus = t.completed.status;
      } catch (e) {
        r.threadStartError = e.message.slice(0, 600);
      }
      await new Promise((res) => setTimeout(res, 1500));
      r.startup = app.notifications.filter((n) => n.method === "mcpServer/startupStatus/updated").map((n) => `${n.params.name}=${n.params.status}`);
      r.warnings = app.notifications.filter((n) => ["warning", "configWarning", "error"].includes(n.method)).map((n) => `${n.method}: ${JSON.stringify(n.params).slice(0, 400)}`);
    } catch (e) {
      r.error = e.message;
    } finally {
      await app.close();
      await fake.close();
    }
    r.spawned = [...new Set(readFileSync(mcpLog, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter((e) => e.event === "spawned").map((e) => e.name))];
    r.toolsDeclaredToModel = toolNames(fake.requests.find((x) => x.method === "POST")?.body).filter((n) => n.startsWith("mcp__"));
    // file-system paths codex looked at that matter for "which layers are read"
    const lines = readFileSync(strace, "utf8").split("\n");
    const paths = new Map();
    for (const line of lines) {
      const m = line.match(/^\d+\s+(\w+)\((?:AT_FDCWD, |-?\d+, )?"([^"]+)"[^)]*\)\s*=\s*(.*)$/);
      if (!m) continue;
      const [, sys, p, ret] = m;
      if (!/^\/etc\/codex|^\/root\/\.codex|^\/root\/\.agents|^\/etc\/\.?agents|\/\.codex(\/|$)|\/\.agents(\/|$)|AGENTS|managed|requirements|^\/Library|^\/usr\/share\/codex|^\/opt\/codex/.test(p)) continue;
      if (p.startsWith(join(HERE, "node_modules"))) continue;
      const key = p.replace(d.root, "<run>");
      const outcome = ret.startsWith("-1") ? ret.replace(/^-1 /, "") : "OK";
      const prev = paths.get(key) ?? new Set();
      prev.add(`${sys}:${outcome}`);
      paths.set(key, prev);
    }
    r.straceRelevantPaths = Object.fromEntries([...paths].map(([k, v]) => [k, [...v]]));
    results[label] = r;
    console.log(`=== ${label}\n${JSON.stringify(r, null, 1)}`);
  };

  // 1) policy allowed by requirements.toml; observe which planted servers spawn
  await run("allowed-untrusted", { approvalPolicy: "untrusted" });
  // 2) policy NOT allowed by requirements.toml — the product's allow-all uses "never"
  await run("disallowed-never", { approvalPolicy: "never" });
  // 3) can thread config disable the system + managed servers?
  await run("thread-disables-etc", {
    approvalPolicy: "untrusted",
    config: { mcp_servers: { etc_system: { enabled: false }, etc_managed: { enabled: false } } },
  });
} finally {
  rmSync("/etc/codex", { recursive: true, force: true });
  results.cleanup = { etcCodexRemoved: !existsSync("/etc/codex") };
  writeJson(join(HERE, "results", "b4-system.json"), results);
  console.log("cleanup", results.cleanup);
}
