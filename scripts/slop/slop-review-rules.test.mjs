import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { countFile } from "./rules.mjs";
import {
  countSpawnWithoutErrorListener,
  fetchCallsWithoutSignal,
  stripComments,
} from "./review-rules.mjs";

const fetches = (text) => fetchCallsWithoutSignal(text).length;

const CHILD_PROCESS = 'import { spawn, fork } from "node:child_process";\n';
const spawns = (body) => countSpawnWithoutErrorListener(CHILD_PROCESS + body);

describe("review rules", () => {
  it("runs through countFile like the other rules", () => {
    const counts = countFile("sdk/src/x.ts", "await fetch(url);\n");
    assert.equal(counts["fetch-without-signal"], 1);
    assert.equal(counts["spawn-without-error-listener"], 0);
  });

  it("blanks comments and literals without moving offsets", () => {
    const text = 'const a = `x${`y${z}`}w` + "q(" // fetch(u)\nfetch(u)';
    const code = stripComments(text, { blankStrings: true });
    assert.equal(code.length, text.length);
    assert.equal(code.indexOf("fetch"), text.lastIndexOf("fetch"));
    assert.equal(stripComments('"a" /* b */', {}), '"a"        ');
  });

  it("reads a slash after postfix ++ or an identifier named of as division", () => {
    assert.equal(fetches("const x = n++ / 2; fetch(u); const y = 1 / 3;\n"), 1);
    assert.equal(fetches("const z = of / 2; fetch(u); const w = 6 / 3;\n"), 1);
    assert.equal(fetches("for (const m of /fetch(x)/g.exec(s)) go(m);\n"), 0);
  });

  it("counts fetch calls whose missing signal is visible", () => {
    assert.equal(fetches("const r = await fetch(url);\n"), 1);
    assert.equal(fetches('await fetch(`${base}/x`, { method: "POST" });\n'), 1);
    assert.equal(fetches("globalThis.fetch(url, { headers });\n"), 1);
    assert.equal(fetches("fetch(a);\nfetch(b);\n"), 2);
    assert.equal(fetches("const r = ok ? await fetch(url) : cached;\n"), 1);
  });

  it("does not count fetch calls that pass a signal or may carry one", () => {
    assert.equal(fetches("await fetch(url, { signal });\n"), 0);
    assert.equal(
      fetches("await fetch(url, { signal: AbortSignal.timeout(5000) });\n"),
      0,
    );
    assert.equal(fetches("await fetch(url, init);\n"), 0);
    assert.equal(fetches('await fetch(url, { ...init, method: "GET" });\n'), 0);
    assert.equal(fetches("const f = (...args) => fetch(...args);\n"), 0);
  });

  it("does not count fetch in comments, strings, methods or other objects", () => {
    assert.equal(fetches("// a later fetch(url) retries\n"), 0);
    assert.equal(fetches("/* fetch (paging) */\n"), 0);
    assert.equal(fetches('const src = "e.waitUntil(fetch(url))";\n'), 0);
    assert.equal(
      fetches("export default { async fetch(request, env) { return x; } };\n"),
      0,
    );
    assert.equal(
      fetches("class W { fetch(request: Request): Response { return r; } }\n"),
      0,
    );
    assert.equal(fetches("await client.fetch(url);\n"), 0);
    assert.equal(fetches("const r = /fetch(x)/.test(s);\n"), 0);
  });

  it("counts a spawned child that nothing listens to for errors", () => {
    assert.equal(
      spawns('const child = spawn("codex", args);\nchild.on("exit", done);\n'),
      1,
    );
    assert.equal(spawns('const child: ChildProcess = spawn("x");\n'), 1);
    assert.equal(spawns('let worker;\nworker = fork("w.js");\n'), 1);
    assert.equal(
      spawns('this.child = cp.spawn("x");\nthis.child.on("exit", f);\n'),
      1,
    );
  });

  it("does not count a child with an error listener, or one handed elsewhere", () => {
    assert.equal(
      spawns('const child = spawn("x");\nchild.on("error", reject);\n'),
      0,
    );
    assert.equal(
      spawns("const child = spawn(\"x\");\nchild.once('error', reject);\n"),
      0,
    );
    assert.equal(
      spawns('const child = spawn("x");\nawait once(child, "error");\n'),
      0,
    );
    assert.equal(spawns('const child = spawn("x").on("error", reject);\n'), 0);
    assert.equal(
      spawns('this.child = spawn("x");\nthis.child?.on("error", f);\n'),
      0,
    );
    assert.equal(spawns('return spawn("x", { stdio: "inherit" });\n'), 0);
    assert.equal(spawns('const src = `const child = spawn("x");`;\n'), 0);
    assert.equal(
      countSpawnWithoutErrorListener('const child = spawn("x");\n'),
      0,
      "spawn from a module that is not child_process",
    );
  });
});
