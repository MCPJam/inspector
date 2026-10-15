import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "check-service-credential-reads.mjs",
);

function tree(files) {
  const root = mkdtempSync(join(tmpdir(), "mcpjam-cred-guard-"));
  for (const [path, text] of Object.entries(files)) {
    const full = join(root, path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, text);
  }
  return { root, done: () => rmSync(root, { recursive: true, force: true }) };
}

function run(root) {
  return spawnSync(process.execPath, [SCRIPT, "--root", root], {
    encoding: "utf8",
  });
}

const MODULE_SOURCE =
  "export const f = (env = process.env) => env.INSPECTOR_SERVICE_TOKEN?.trim();\n";

test("the real tree has no raw reads outside the module", () => {
  const result = spawnSync(process.execPath, [SCRIPT], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /service-credential-reads: ok/);
});

test("the module itself and tests may read the variable", () => {
  const t = tree({
    "server/services/service-credential.ts": MODULE_SOURCE,
    "server/services/__tests__/x.test.ts":
      'vi.stubEnv("INSPECTOR_SERVICE_TOKEN", "t"); process.env.INSPECTOR_SERVICE_TOKEN;\n',
    "server/routes/clean.ts":
      'import { getServiceCredential } from "../services/service-credential.js";\n// process.env.INSPECTOR_SERVICE_TOKEN in a comment is fine\nexport const t = getServiceCredential();\n',
    "server/routes/other.ts":
      "export const v = process.env.MCPJAM_INSPECTOR_SERVICE_TOKEN;\n",
  });
  try {
    const result = run(t.root);
    assert.equal(result.status, 0, result.stderr);
  } finally {
    t.done();
  }
});

for (const [label, source] of [
  ["process.env member", "const t = process.env.INSPECTOR_SERVICE_TOKEN;\n"],
  [
    "env parameter",
    "function f(env) { return env.INSPECTOR_SERVICE_TOKEN; }\n",
  ],
  ["optional chain", "const t = options.env?.INSPECTOR_SERVICE_TOKEN;\n"],
  ["bracket", 'const t = process.env["INSPECTOR_SERVICE_TOKEN"];\n'],
  ["destructure", "const { INSPECTOR_SERVICE_TOKEN } = process.env;\n"],
]) {
  test(`a raw read (${label}) outside the module fails`, () => {
    const t = tree({
      "server/services/service-credential.ts": MODULE_SOURCE,
      "server/routes/raw.ts": `// header\n${source}`,
    });
    try {
      const result = run(t.root);
      assert.equal(result.status, 1);
      assert.match(result.stderr, /server\/routes\/raw\.ts:2/);
    } finally {
      t.done();
    }
  });
}

test("scanning zero files fails instead of passing on nothing", () => {
  const t = tree({ "unrelated/readme.md": "hi\n" });
  try {
    const result = run(t.root);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /scanned 0 files/);
  } finally {
    t.done();
  }
});
