import { build } from "esbuild";
import { randomUUID } from "node:crypto";

// Observe on the box rather than adding repeated host RPCs to measured turns.
// Only process names and ancestry are read, never command lines or credentials.
export async function observeProcesses(box, harnessId) {
  const path = "/tmp/mcpjam-observe-" + randomUUID();
  const source = [
    "import {readdirSync,readFileSync,writeFileSync,renameSync,existsSync} from 'node:fs';",
    "import {nativeIdentity} from './scripts/warm-agent/native-identity.mjs';",
    "const observations=new Map();",
    "setInterval(()=>{",
    " const root='/home/user/.agent-runs';",
    " if(!existsSync(root))return;",
    " for(const session of readdirSync(root)) {",
    "  const path=root+'/'+session+'/bridge/bridge-meta.json';",
    "  if(!existsSync(path))continue;",
    "  let meta;try{meta=JSON.parse(readFileSync(path,'utf8'));}catch(e){if(e instanceof SyntaxError||e.code==='ENOENT')continue;throw e;}",
    "  const native=nativeIdentity(meta.pid," +
      JSON.stringify(harnessId) +
      ");",
    "  if(native)observations.set(native.pid+':'+native.birth,{session,...native,observedAt:Date.now()});",
    " }",
    " writeFileSync(" +
      JSON.stringify(path + ".tmp") +
      ",JSON.stringify([...observations.values()]));",
    " renameSync(" +
      JSON.stringify(path + ".tmp") +
      "," +
      JSON.stringify(path + ".json") +
      ");",
    "},100);",
  ].join("\n");
  const compiled = await build({
    stdin: {
      contents: source,
      resolveDir: new URL("../../", import.meta.url).pathname,
    },
    bundle: true,
    platform: "node",
    format: "esm",
    write: false,
  });
  await box.files.write(path + ".mjs", compiled.outputFiles[0].text);
  const process = await box.commands.run("node " + path + ".mjs", {
    background: true,
    timeoutMs: 30 * 60_000,
  });
  return {
    async latest() {
      try {
        const data = JSON.parse(await box.files.read(path + ".json"));
        return data.sort((a, b) => b.observedAt - a.observedAt)[0] ?? null;
      } catch (error) {
        if (error.name === "NotFoundError") return null;
        throw error;
      }
    },
    async close() {
      await process.kill();
      await box.files.remove(path + ".mjs");
      await box.files.remove(path + ".json");
    },
  };
}
