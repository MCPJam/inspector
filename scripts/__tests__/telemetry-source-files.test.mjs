import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { gitSourceFiles, walkedSourceFiles } from "../telemetry-source-files.mjs";

process.chdir(fileURLToPath(new URL("../..", import.meta.url)));

// Docker builds walk the tree; a different file list there ships different catalogs.
test("the no-Git walk finds the same catalog sources as git ls-files", () => {
  assert.deepEqual(walkedSourceFiles().sort(), gitSourceFiles().sort());
});
