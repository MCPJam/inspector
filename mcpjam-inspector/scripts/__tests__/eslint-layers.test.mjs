import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { ESLint } from "eslint";

const eslint = new ESLint({
  cwd: fileURLToPath(new URL("../..", import.meta.url)),
});

async function ruleIds(filePath, code) {
  const [result] = await eslint.lintText(code, { filePath });
  return result.messages.map((m) => m.ruleId);
}

test("a dynamic import across a layer fails like a static one", async () => {
  const cases = [
    ["server/utils/x.ts", 'await import("../../client/src/lib/y");'],
    ["server/utils/x.ts", 'await import(".././../client/src/lib/y");'],
    ["server/utils/x.ts", "await import(`../../../sdk/src/y.js`);"],
    ["client/src/lib/x.ts", 'await import("../../../server/y.js");'],
    ["shared/x.ts", 'await import("node:fs");'],
  ];
  for (const [file, code] of cases) {
    assert.deepEqual(
      await ruleIds(file, code),
      ["layers/no-cross-layer-imports"],
      `${file}: ${code}`,
    );
  }
});

test("a specifier is classified by the module it resolves to", async () => {
  const forbidden = [
    ["shared/x.ts", 'import { y } from "../shared/../client/src/y";'],
    ["shared/x.ts", 'export { y } from "./lib/../../server/y.js";'],
    ["shared/x.ts", 'await import("../shared/../client/src/y");'],
    ["client/src/lib/x.ts", 'import "../../../server/./y.js";'],
  ];
  for (const [file, code] of forbidden) {
    assert.deepEqual(
      await ruleIds(file, code),
      ["layers/no-cross-layer-imports"],
      `${file}: ${code}`,
    );
  }
  const permitted = [
    ["server/utils/x.ts", 'import { y } from "../../client/../server/y.js";'],
    ["shared/x.ts", 'import { y } from "../server/../shared/y";'],
    ["shared/x.ts", 'await import("../client/../shared/y");'],
  ];
  for (const [file, code] of permitted) {
    assert.deepEqual(await ruleIds(file, code), [], `${file}: ${code}`);
  }
});

test("the dynamic import rule survives the server/routes syntax rules", async () => {
  for (const file of ["server/routes/v1/x.ts", "server/routes/web/x.ts"]) {
    assert.deepEqual(
      await ruleIds(file, 'await import("../../../client/src/y");'),
      ["layers/no-cross-layer-imports"],
      file,
    );
  }
});

test("same-layer, package, computed and test-file dynamic imports pass", async () => {
  const cases = [
    ["server/utils/x.ts", 'await import("./y.js");'],
    ["server/utils/x.ts", 'await import("../routes/y.js");'],
    ["server/utils/x.ts", 'await import("@mcpjam/sdk");'],
    ["server/utils/x.ts", "await import(modulePath);"],
    [
      "server/utils/__tests__/x.test.ts",
      'await import("../../../client/src/y");',
    ],
    ["client/src/lib/x.test.ts", 'await import("../../../server/y.js");'],
  ];
  for (const [file, code] of cases) {
    assert.deepEqual(await ruleIds(file, code), [], `${file}: ${code}`);
  }
});
