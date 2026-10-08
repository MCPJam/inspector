// Probe (a2): what does codex app-server contact OTHER than the model provider?
//
// HTTPS_PROXY/HTTP_PROXY/ALL_PROXY point at a local proxy that LOGS every CONNECT / absolute-URI
// request and refuses it (403). NO_PROXY keeps 127.0.0.1 (the fake model server) direct. We run
// initialize -> thread/start -> one text turn -> 15 s idle, and list every target host.
// Variant "disabled" retries with config knobs that look like they govern those calls.
import { createServer } from "node:http";
import { join } from "node:path";
import { writeFileSync } from "node:fs";
import { createFake, freshDirs, renderConfig, startAppServer, writeJson, HERE } from "./lib.mjs";

async function run(name, extra) {
  const hits = [];
  const proxy = createServer((req, res) => {
    hits.push({ t: Date.now(), kind: "http", method: req.method, url: req.url });
    res.writeHead(403);
    res.end("blocked by probe proxy");
  });
  proxy.on("connect", (req, socket) => {
    hits.push({ t: Date.now(), kind: "CONNECT", target: req.url });
    socket.end("HTTP/1.1 403 Forbidden\r\n\r\n");
  });
  await new Promise((r) => proxy.listen(0, "127.0.0.1", r));
  const proxyUrl = `http://127.0.0.1:${proxy.address().port}`;
  const d = freshDirs(`a2-${name}`);
  const fake = createFake({ script: [{ text: "ok" }], logPath: join(d.root, "http.ndjson") });
  const origin = await fake.listen();
  writeFileSync(join(d.codexHome, "config.toml"), renderConfig({ baseUrl: `${origin}/v1`, extra }));
  const t0 = Date.now();
  const app = startAppServer({
    codexHome: d.codexHome,
    cwd: d.cwd,
    home: d.home,
    env: {
      TMPDIR: d.tmp,
      HTTPS_PROXY: proxyUrl, https_proxy: proxyUrl, HTTP_PROXY: proxyUrl, http_proxy: proxyUrl, ALL_PROXY: proxyUrl, all_proxy: proxyUrl,
      NO_PROXY: "127.0.0.1,localhost", no_proxy: "127.0.0.1,localhost",
    },
    logPath: join(d.root, "rpc.ndjson"),
  });
  const r = { name, extra };
  try {
    await app.init();
    const t = await app.startThreadAndTurn({ threadParams: { cwd: d.cwd, approvalPolicy: "never", sandbox: "read-only" }, prompt: "hi", timeoutMs: 45_000 });
    r.turnStatus = t.completed.status;
    await new Promise((res) => setTimeout(res, 15_000));
  } catch (e) {
    r.error = e.message;
  } finally {
    await app.close();
    await fake.close();
    proxy.closeAllConnections?.();
    await new Promise((res) => proxy.close(res));
  }
  r.modelProviderRequests = fake.requests.map((q) => `${q.method} ${q.url}`);
  r.proxiedEgress = hits.map((h) => ({ dtMs: h.t - t0, ...h, t: undefined }));
  r.egressTargets = [...new Set(hits.map((h) => h.target ?? h.url))];
  r.stderrMentions = app.stderr.join("").split("\n").filter((l) => /https?:\/\/|featured|plugin|update|analytics|telemetry/i.test(l)).map((l) => l.replace(/\x1b\[[0-9;]*m/g, "").slice(0, 300)).slice(0, 12);
  writeJson(join(HERE, "results", `a2-${name}.json`), r);
  console.log(`===== ${name}\n${JSON.stringify(r, null, 1)}`);
}

const only = process.argv.slice(2);
const want = (n) => !only.length || only.includes(n);
if (want("default")) await run("default", "");
if (want("plugins-off")) await run("plugins-off", ["[features]", "plugins = false"].join("\n"));
if (want("knobs-off")) await run("knobs-off", ["check_for_update_on_startup = false", "", "[analytics]", "enabled = false", "", "[features]", "plugins = false", "apps = false"].join("\n"));
