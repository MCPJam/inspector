// Probe (a): which request paths does codex hit for a given model_provider base_url?
// Variants: bare origin, origin + "/v1", origin + "/v1/" (trailing slash).
// Each variant: fresh CODEX_HOME + HOME, one text-only turn, plus `model/list`
// (to see whether it triggers GET .../models), then dump every request the fake
// server saw (method + raw url).
import { join } from "node:path";
import { writeFileSync } from "node:fs";
import { createFake, freshDirs, renderConfig, startAppServer, writeJson } from "./lib.mjs";

const variants = [
  ["bare-origin", (o) => o],
  ["origin-v1", (o) => `${o}/v1`],
  ["origin-v1-slash", (o) => `${o}/v1/`],
];
const results = {};
for (const [name, mk] of variants) {
  const d = freshDirs(`a-${name}`);
  const fake = createFake({ script: [{ text: "Hello." }], logPath: join(d.root, "http.ndjson") });
  const origin = await fake.listen();
  const baseUrl = mk(origin);
  writeFileSync(join(d.codexHome, "config.toml"), renderConfig({ baseUrl }));
  const app = startAppServer({ codexHome: d.codexHome, cwd: d.cwd, home: d.home, env: { TMPDIR: d.tmp }, logPath: join(d.root, "rpc.ndjson") });
  const r = { baseUrl };
  try {
    await app.init();
    const t = await app.startThreadAndTurn({
      threadParams: { cwd: d.cwd, approvalPolicy: "never", sandbox: "read-only" },
      prompt: "Say hello.",
      timeoutMs: 45_000,
    });
    r.turnStatus = t.completed.status;
    r.turnError = t.completed.error ?? null;
    r.modelProvider = t.thread.modelProvider;
    try {
      const ml = await app.request("model/list", {}, 20_000);
      r.modelList = { count: (ml.data ?? ml.models ?? []).length };
    } catch (e) {
      r.modelList = { error: e.message.slice(0, 300) };
    }
    r.errors = app.notifications.filter((n) => n.method === "error").map((n) => n.params?.error?.message ?? n.params);
  } catch (e) {
    r.error = e.message;
  } finally {
    await app.close();
    await fake.close();
  }
  r.requests = fake.requests.map((q) => `${q.method} ${q.url}${q.upgrade ? ` (upgrade:${q.upgrade})` : ""}`);
  results[name] = r;
  console.log(name, JSON.stringify(r, null, 1));
}
writeJson(join(new URL(".", import.meta.url).pathname, "results", "a.json"), results);
