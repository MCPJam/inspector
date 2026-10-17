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
  "check-turn-entry-point.mjs",
);

const ENGINES = [
  "server/utils/turn-execution.ts",
  "server/utils/assistant-turn.ts",
  "server/utils/direct-chat-turn.ts",
  "server/utils/direct-chat-turn-full-stream.ts",
  "server/utils/mcpjam-stream-handler.ts",
  "server/utils/org-model-stream-handler.ts",
  "server/utils/harness/run-harness-turn.ts",
];

/** A tree whose engines exist and whose two exceptions still bypass. */
function tree(files) {
  const root = mkdtempSync(join(tmpdir(), "mcpjam-turn-guard-"));
  const all = {
    ...Object.fromEntries(ENGINES.map((path) => [path, "export {};\n"])),
    "server/routes/mcp/chat-v2.ts":
      'import { runDirectChatTurn } from "../../utils/direct-chat-turn.js";\n',
    "server/utils/web-chat-turn.ts":
      'import { handleLocalOrgChatModel } from "./org-model-stream-handler";\n',
    ...files,
  };
  for (const [path, text] of Object.entries(all)) {
    if (text === null) continue;
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

test("the real tree starts every turn through the facade", () => {
  const result = spawnSync(process.execPath, [SCRIPT], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /turn-entry-point: ok/);
});

test("the facade, type-only imports, tests and other names are allowed", () => {
  const t = tree({
    "server/services/evals/driver.ts": [
      'import { runUnifiedAssistantTurn } from "../../utils/turn-execution.js";',
      'import type { RunAssistantTurnOptions } from "../../utils/assistant-turn.js";',
      'import { type RunDirectChatTurnHandle } from "../../utils/direct-chat-turn.js";',
      'import { resolveLocalOrgMaxSteps } from "../../utils/org-model-stream-handler.js";',
      '// import { runAssistantTurn } from "../../utils/assistant-turn.js";',
      "",
    ].join("\n"),
    "server/services/evals/__tests__/driver.test.ts":
      'import { runAssistantTurn } from "../../../utils/assistant-turn.js";\n',
  });
  try {
    const result = run(t.root);
    assert.equal(result.status, 0, result.stderr);
  } finally {
    t.done();
  }
});

for (const [label, source, hit] of [
  [
    "named",
    'import { runAssistantTurn } from "../utils/assistant-turn.js";',
    "runAssistantTurn",
  ],
  [
    "aliased",
    'import { runDirectChatTurn as run } from "../utils/direct-chat-turn";',
    "runDirectChatTurn",
  ],
  [
    "re-export",
    'export { runHarnessTurn } from "../utils/harness/run-harness-turn.js";',
    "runHarnessTurn",
  ],
  ["package", 'import { streamText } from "ai";', "streamText"],
  [
    "namespace",
    'import * as engine from "../utils/mcpjam-stream-handler.js";',
    "* as ../utils/mcpjam-stream-handler.js",
  ],
]) {
  test(`a ${label} engine import outside the engine layer fails`, () => {
    const t = tree({ "server/routes/new-route.ts": `// header\n${source}\n` });
    try {
      const result = run(t.root);
      assert.equal(result.status, 1);
      assert.ok(
        result.stderr.includes(`server/routes/new-route.ts imports ${hit}:2`),
        result.stderr,
      );
    } finally {
      t.done();
    }
  });
}

test("an exception that no longer bypasses the facade is stale", () => {
  const t = tree({ "server/utils/web-chat-turn.ts": "export {};\n" });
  try {
    const result = run(t.root);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /no longer import an engine/);
    assert.match(result.stderr, /server\/utils\/web-chat-turn\.ts/);
  } finally {
    t.done();
  }
});

test("a renamed engine-layer file fails instead of silently widening", () => {
  const t = tree({ "server/utils/assistant-turn.ts": null });
  try {
    const result = run(t.root);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /ENGINE_LAYER files do not exist/);
  } finally {
    t.done();
  }
});

test("scanning zero files fails instead of passing on nothing", () => {
  const root = mkdtempSync(join(tmpdir(), "mcpjam-turn-guard-empty-"));
  try {
    const result = run(root);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /scanned 0 files/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
