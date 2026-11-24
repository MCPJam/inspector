import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { checkEdit } from "./hook.mjs";
import { countFile } from "./rules.mjs";
import {
  countSpawnWithoutErrorListener,
  fetchCallsWithoutSignal,
} from "./review-rules.mjs";

const fetches = (text) => fetchCallsWithoutSignal(text, "a.ts").length;

const CHILD_PROCESS = 'import { spawn, fork } from "node:child_process";\n';
const spawns = (body) =>
  countSpawnWithoutErrorListener(CHILD_PROCESS + body, "a.ts");

describe("review rules", () => {
  it("runs through countFile like the other rules", () => {
    const counts = countFile("sdk/src/x.ts", "await fetch(url);\n");
    assert.equal(counts["fetch-without-signal"], 1);
    assert.equal(counts["spawn-without-error-listener"], 0);
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
    assert.equal(
      fetches('await fetch(url, { "signal": AbortSignal.timeout(25) });\n'),
      0,
    );
  });

  it("reads only the options' own signal, and counts one set to undefined", () => {
    assert.equal(
      fetches('await fetch(url, { headers: { signal: "blue" } });\n'),
      1,
    );
    assert.equal(fetches("await fetch(url, { signal: undefined });\n"), 1);
    assert.equal(fetches("await fetch(url, { signal: null });\n"), 1);
    assert.equal(fetches("await fetch(url, { signal: opts.signal });\n"), 0);
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
    assert.equal(
      spawns('const child = spawn("x");\nchild.on("exit", f).on("close", g);\n'),
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
      spawns('const child = spawn("x");\nchild.on("exit", f).on("error", g);\n'),
      0,
    );
    assert.equal(
      spawns('this.child = spawn("x");\nthis.child?.on("error", f);\n'),
      0,
    );
    assert.equal(spawns('return spawn("x", { stdio: "inherit" });\n'), 0);
    assert.equal(spawns('const src = `const child = spawn("x");`;\n'), 0);
    assert.equal(
      countSpawnWithoutErrorListener('const child = spawn("x");\n', "a.ts"),
      0,
      "spawn from a module that is not child_process",
    );
  });

  it("matches a listener only in the scope of the child it names", () => {
    const first =
      'function a() {\n  const child = spawn("x");\n  child.on("error", f);\n}\n';
    const second = 'function b() {\n  const child = spawn("y");\n}\n';
    assert.equal(spawns(first + second), 1);
    assert.equal(spawns(first), 0);
    assert.equal(
      spawns(
        'class R {\n  start() { this.child = spawn("x"); }\n  watch() { this.child.on("error", f); }\n}\n',
      ),
      0,
    );
  });

  it("does not see a listener a helper adds to a child passed to it", () => {
    assert.equal(
      spawns('const child = spawn("x");\nawait waitForExit(child);\n'),
      1,
    );
  });

  it("prints the fix from the edit hook", () => {
    const problem = checkEdit("sdk/src/a.ts", {
      before: "const a = 1;",
      after: "await fetch(url);",
      fileBefore: "const a = 1;\n",
      fileAfter: "await fetch(url);\n",
    });
    assert.match(problem, /no `signal`: \+1\. Pass a `signal`/);
  });
});
