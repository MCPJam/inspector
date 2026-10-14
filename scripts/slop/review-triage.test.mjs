import { test } from "node:test";
import assert from "node:assert/strict";
import { applyEdit, autofixAllowedFor, locate, triage, validate } from "./review-triage.mjs";

const FILE = "const a = 1;\nconst b = 2;\nconst a = 1;\nexport { a, b };\n";
const files = { "src/x.ts": FILE, ".github/workflows/ci.yml": "run: test\n" };
const readFile = (path) => files[path] ?? null;
const item = (fields) => ({
  feedback: 0, category: "autofix", title: "t", path: "src/x.ts", find: "const b = 2;",
  replace: "const b = 3;", why: "w", options: [], commit: "Fix b", ...fields,
});

test("snippets are placed only on whole lines that occur exactly once", () => {
  assert.deepEqual(locate(FILE, "const b = 2;"), { start: 2, end: 2 });
  assert.deepEqual(locate(FILE, "const a = 1;\nexport { a, b };"), { start: 3, end: 4 });
  assert.equal(locate(FILE, "const a = 1;"), null, "ambiguous");
  assert.equal(locate(FILE, "b = 2"), null, "partial line");
  assert.equal(locate(FILE, "  "), null);
  assert.equal(applyEdit(FILE, "const b = 2;", ""), "const a = 1;\nconst a = 1;\nexport { a, b };\n");
  assert.equal(applyEdit(FILE, "const b = 2;", "const b = 2;\nconst c = 3;").split("\n")[2], "const c = 3;");
});

test("the bot never commits to CI, its own gate, lockfiles or generated files", () => {
  for (const path of [".github/workflows/x.yml", "scripts/slop/rules.mjs", "package-lock.json",
    "sdk/package-lock.json", "mcpjam-inspector/server/services/browserd/dist/daemon.js", "DESIGN.md"]) {
    assert.equal(autofixAllowedFor(path), false, path);
  }
  assert.equal(autofixAllowedFor("mcpjam-inspector/client/src/a.ts"), true);
});

test("a valid autofix stays an autofix with a one-line commit subject", () => {
  const [result] = validate([item({ commit: "Fix b\nsecond line" })], { readFile, autofix: true });
  assert.equal(result.category, "autofix");
  assert.equal(result.commit, "Fix b");
});

test("autofixes that cannot run are posted as suggestions, with the reason", () => {
  const cases = [
    [item({}), false, /limit/],
    [item({ path: ".github/workflows/ci.yml", find: "run: test", replace: "run: lint" }), true, /does not commit/],
    [item({ find: "const a = 1;" }), true, /did not apply/],
    [item({ replace: "const b = 2;" }), true, /did not apply/],
  ];
  for (const [input, autofix, reason] of cases) {
    const [result] = validate([input], { readFile, autofix, autofixReason: "the autofix limit for this PR was reached" });
    assert.match(result.downgraded, reason);
    assert.notEqual(result.category, "autofix");
  }
  const [suggestMode] = validate([item({})], { readFile, autofix: false, autofixReason: "the pipeline is in suggest mode" });
  assert.deepEqual([suggestMode.category, suggestMode.downgraded], ["suggest", "the pipeline is in suggest mode"]);
  const seven = Array.from({ length: 7 }, (_, index) => `line ${index}`).join("\n");
  const many = validate(Array.from({ length: 7 }, (_, index) => item({ path: "src/many.ts", find: `line ${index}`, replace: `fixed ${index}` })),
    { readFile: (path) => (path === "src/many.ts" ? seven : null), autofix: true });
  assert.equal(many.filter((entry) => entry.category === "autofix").length, 5);
});

test("an autofix overlapping an earlier accepted one is posted as a suggestion", () => {
  const lines = { "src/y.ts": "A\nB\nC\n" };
  const read = (path) => lines[path] ?? null;
  const result = validate([
    item({ path: "src/y.ts", find: "A\nB", replace: "B" }),
    item({ path: "src/y.ts", find: "B", replace: "C" }),
    item({ path: "src/y.ts", find: "C", replace: "D" }),
  ], { readFile: read, autofix: true });
  assert.deepEqual(result.map((entry) => entry.category), ["autofix", "suggest", "autofix"]);
  assert.equal(result[1].downgraded, "the edit overlaps an earlier autofix");
});

test("a suggestion that cannot be placed becomes a discussion; a discussion keeps only a valid anchor", () => {
  const [moved] = validate([item({ category: "suggest", find: "missing line" })], { readFile, autofix: true });
  assert.equal(moved.category, "discuss");
  assert.match(moved.options[0], /const b = 3;/);
  const [loose] = validate([item({ category: "discuss", find: "const a = 1;", replace: "" })], { readFile, autofix: true });
  assert.equal(loose.find, "");
  const [general] = validate([item({ category: "discuss", path: "", find: "", replace: "" })], { readFile, autofix: true });
  assert.equal(general.category, "discuss");
});

test("triage calls Claude only when there is feedback, and drops unknown categories", async () => {
  let calls = 0;
  const gate = { autofix: true };
  assert.deepEqual(await triage({ gate, feedback: { phase: "ci", items: [], files: [] }, readFile, call: async () => { calls++; } }), []);
  assert.equal(calls, 0);
  const result = await triage({
    gate, readFile,
    feedback: { phase: "review", items: [{ title: "x" }], files: [{ path: "src/x.ts", after: FILE }] },
    call: async (input) => {
      calls++;
      assert.equal(input.effort, "medium");
      const user = JSON.parse(input.user);
      assert.equal(user.autofixAllowed, true);
      assert.equal(user.feedback[0].index, 0);
      return { items: [item({}), item({ category: "ignore" })] };
    },
  });
  assert.equal(calls, 1);
  assert.deepEqual(result.map((entry) => entry.category), ["autofix"]);
});
