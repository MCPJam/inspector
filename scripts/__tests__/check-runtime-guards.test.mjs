import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const THIS_FILE = fileURLToPath(import.meta.url);
const REPO = join(dirname(THIS_FILE), "..", "..");
const SCRIPT = join(REPO, "scripts", "check-runtime-guards.mjs");

const CLEAN = "export const x = 1;\n";

// Every root each check scans, populated with a clean file so a test only
// has to name the file it is about.
const ROOT_FILES = {
  "mcp-v1-runtime-imports": {
    "sdk/src/a.ts": CLEAN,
    "cli/src/a.ts": CLEAN,
    "mcpjam-inspector/client/src/a.ts": CLEAN,
    "mcpjam-inspector/server/a.ts": CLEAN,
    "mcp/src/a.ts": CLEAN,
  },
  "platform-runtime-safety": {
    "sdk/src/platform/a.ts": CLEAN,
    "sdk/src/deployment/address.ts": CLEAN,
  },
  "platform-runtime-safety-dist": {
    "sdk/dist/platform/a.js": CLEAN,
  },
  "platform-entry-runtime-safety-dist": {
    "sdk/dist/browser.js": CLEAN,
    "sdk/dist/worker.js": CLEAN,
    "sdk/dist/model-factory.js": CLEAN,
  },
  "cloud-default-literals": {
    "sdk/src/a.ts": CLEAN,
    "cli/src/a.ts": CLEAN,
  },
};

function tree(check, files = {}) {
  const root = mkdtempSync(join(tmpdir(), "mcpjam-runtime-guards-"));
  for (const [path, text] of Object.entries({
    ...ROOT_FILES[check],
    ...files,
  })) {
    const full = join(root, path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, text);
  }
  return root;
}

function run(check, root) {
  const args = root ? [SCRIPT, check, "--root", root] : [SCRIPT, check];
  return spawnSync(process.execPath, args, { encoding: "utf8" });
}

function runTree(check, files) {
  const root = tree(check, files);
  try {
    return run(check, root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const VIOLATIONS = {
  "mcp-v1-runtime-imports": [
    "mcpjam-inspector/server/bad.ts",
    'import { Client } from "@modelcontextprotocol/sdk/client";\n',
  ],
  "platform-runtime-safety": [
    "sdk/src/platform/bad.ts",
    'import { readFileSync } from "node:fs";\n',
  ],
  "platform-runtime-safety-dist": [
    "sdk/dist/platform/bad.js",
    "const k = process.env.KEY;\n",
  ],
  "platform-entry-runtime-safety-dist": [
    "sdk/dist/worker.js",
    "import { createHash } from 'node:crypto';\n",
  ],
  "cloud-default-literals": [
    "cli/src/bad.ts",
    'const url = "https://app.mcpjam.com";\n',
  ],
};

const MISSING_ROOTS = {
  "mcp-v1-runtime-imports": "mcp/src",
  "platform-runtime-safety": "sdk/src/platform",
  "platform-runtime-safety-dist": "sdk/dist/platform",
  "platform-entry-runtime-safety-dist": "sdk/dist/worker.js",
  "cloud-default-literals": "cli/src",
};

for (const [check, [file, text]] of Object.entries(VIOLATIONS)) {
  const missingRoot = MISSING_ROOTS[check];

  test(`${check}: a clean tree passes`, () => {
    const result = runTree(check);
    assert.equal(result.status, 0, result.stderr);
    assert.ok(result.stdout.includes(`[${check}]: clean`), result.stdout);
  });

  test(`${check}: a violation fails and names the file and line`, () => {
    const result = runTree(check, { [file]: `// header\n${text}` });
    assert.equal(result.status, 1);
    assert.ok(result.stderr.includes(`${file}:2 `), result.stderr);
  });

  test(`${check}: a missing scan root fails instead of passing`, () => {
    const root = tree(check);
    try {
      rmSync(join(root, missingRoot), { recursive: true, force: true });
      const result = run(check, root);
      assert.equal(result.status, 1);
      assert.match(result.stderr, /does not exist/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}

test("a scan that reads zero files fails", () => {
  const root = mkdtempSync(join(tmpdir(), "mcpjam-runtime-guards-"));
  try {
    mkdirSync(join(root, "sdk/dist/platform"), { recursive: true });
    writeFileSync(join(root, "sdk/dist/platform/a.js.map"), "process.env");
    const result = run("platform-runtime-safety-dist", root);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /scanned 0 files/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an unknown check name fails", () => {
  const result = run("no-such-check");
  assert.equal(result.status, 1);
  assert.match(result.stderr, /unknown check "no-such-check"/);
});

test("mcp-v1-runtime-imports skips mcp/src/ui, dist and generated files", () => {
  const raw = 'import "@modelcontextprotocol/sdk";\n';
  const result = runTree("mcp-v1-runtime-imports", {
    "mcp/src/ui/widget.ts": raw,
    "sdk/src/dist/out.js": raw,
    "sdk/src/runtime.bundled.ts": raw,
    "cli/src/schema.generated.ts": raw,
  });
  assert.equal(result.status, 0, result.stderr);
});

test("cloud-default-literals allows comment lines and the listed files", () => {
  const result = runTree("cloud-default-literals", {
    "sdk/src/deployment/address.ts":
      'export const CLOUD = "https://app.mcpjam.com";\n',
    "cli/src/doc.ts": "// see https://app.mcpjam.com\nexport {};\n",
  });
  assert.equal(result.status, 0, result.stderr);
});

test("--root without a directory fails", () => {
  const result = spawnSync(
    process.execPath,
    [SCRIPT, "platform-runtime-safety", "--root"],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 1);
  assert.match(result.stderr, /--root needs a directory/);
});

test("without --root the script scans this repository", () => {
  const result = run("platform-runtime-safety");
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /clean \(\d+ files scanned\)/);
});

// Guards in `test:checks` that no test drives yet. Each entry is a known gap:
// remove it when the script gains a test.
const UNTESTED_GUARDS = [
  "scripts/check-bundled-runtime-paths.mjs",
  "scripts/check-permalink-concatenation.mjs",
  "mcpjam-inspector/scripts/check-hosted-manager-base-fetch.mjs",
];

test("every guard in test:checks has a test or is listed as untested", () => {
  const { scripts } = JSON.parse(
    readFileSync(join(REPO, "package.json"), "utf8"),
  );
  const guards = [...scripts["test:checks"].matchAll(/npm run (check:\S+)/g)]
    .flatMap(([, name]) => [
      ...scripts[name].matchAll(/node (\S+\.mjs)(?: ([\w-]+))?/g),
    ])
    .map(([, script, mode]) => ({ script, mode }));
  assert.ok(guards.length > 0, "found no node guard in test:checks");
  const otherTests = ["scripts/__tests__", "mcpjam-inspector/scripts/__tests__"]
    .flatMap((dir) =>
      readdirSync(join(REPO, dir))
        .filter((name) => name.endsWith(".test.mjs"))
        .map((name) => join(REPO, dir, name)),
    )
    .filter((file) => file !== THIS_FILE)
    .map((file) => readFileSync(file, "utf8"));
  const tested = ({ script, mode }) =>
    script === "scripts/check-runtime-guards.mjs"
      ? mode in VIOLATIONS
      : otherTests.some((text) => text.includes(script.split("/").pop()));
  const untested = [
    ...new Set(guards.filter((g) => !tested(g)).map((g) => g.script)),
  ];
  assert.deepEqual(untested.sort(), [...UNTESTED_GUARDS].sort());
});
