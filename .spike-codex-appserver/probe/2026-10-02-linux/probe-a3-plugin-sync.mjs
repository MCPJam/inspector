// Probe (a3): with real egress available (the container's proxy), what does a FRESH CODEX_HOME
// download at startup, and does `[features] plugins = false` stop it? Measures CODEX_HOME size.
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, writeFileSync } from "node:fs";
import { createFake, freshDirs, renderConfig, startAppServer, writeJson, HERE } from "./lib.mjs";
const out = {};
for (const [name, extra] of [["default", ""], ["plugins-off", "[features]\nplugins = false"]]) {
  const d = freshDirs(`a3-${name}`);
  const fake = createFake({ script: [{ text: "ok" }] });
  const origin = await fake.listen();
  writeFileSync(join(d.codexHome, "config.toml"), renderConfig({ baseUrl: `${origin}/v1`, extra }));
  const app = startAppServer({ codexHome: d.codexHome, cwd: d.cwd, home: d.home, env: { TMPDIR: d.tmp } });
  try {
    await app.init();
    await app.startThreadAndTurn({ threadParams: { cwd: d.cwd, approvalPolicy: "never", sandbox: "read-only" }, prompt: "hi", timeoutMs: 45000 });
    await new Promise((r) => setTimeout(r, 20000));
  } finally { await app.close(); await fake.close(); }
  const tmp = join(d.codexHome, ".tmp");
  out[name] = {
    codexHomeSize: execFileSync("du", ["-sh", d.codexHome], { encoding: "utf8" }).split("\t")[0],
    dotTmp: existsSync(tmp) ? readdirSync(tmp) : null,
    pluginsDir: existsSync(join(d.codexHome, "plugins")) ? execFileSync("du", ["-sh", join(d.codexHome, "plugins")], { encoding: "utf8" }).trim() : null,
    stderrPlugin: app.stderr.join("").split("\n").filter((l) => /plugin/i.test(l)).map((l) => l.replace(/\x1b\[[0-9;]*m/g, "").slice(0, 220)).slice(0, 4),
  };
}
writeJson(join(HERE, "results", "a3-plugin-sync.json"), out);
console.log(JSON.stringify(out, null, 1));
