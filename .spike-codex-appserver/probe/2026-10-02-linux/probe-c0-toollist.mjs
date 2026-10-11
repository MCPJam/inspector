// Which tools does 0.149.1 declare per model? (looking for apply_patch / shell variants)
import { join } from "node:path";
import { writeFileSync } from "node:fs";
import { createFake, freshDirs, renderConfig, startAppServer, writeJson, HERE } from "./lib.mjs";
const out = {};
for (const model of ["gpt-5-nano", "gpt-5.5", "gpt-5.2-codex", "gpt-5.3-codex", "gpt-5.1-codex-max"]) {
  const d = freshDirs(`c0-${model}`);
  const fake = createFake({ script: [{ text: "ok" }] });
  const origin = await fake.listen();
  writeFileSync(join(d.codexHome, "config.toml"), renderConfig({ baseUrl: `${origin}/v1` }));
  const app = startAppServer({ codexHome: d.codexHome, cwd: d.cwd, home: d.home, env: { TMPDIR: d.tmp } });
  try {
    await app.init();
    await app.startThreadAndTurn({ threadParams: { cwd: d.cwd, model, approvalPolicy: "untrusted", sandbox: "workspace-write" }, prompt: "hi", timeoutMs: 30000 });
  } finally { await app.close(); await fake.close(); }
  const body = fake.requests.find((r) => r.method === "POST")?.body;
  out[model] = (body?.tools ?? []).map((t) => `${t.name ?? t.type}:${t.type}${t.format ? `(format:${t.format.type})` : ""}`);
}
writeJson(join(HERE, "results", "c0-toollist.json"), out);
console.log(JSON.stringify(out, null, 1));
