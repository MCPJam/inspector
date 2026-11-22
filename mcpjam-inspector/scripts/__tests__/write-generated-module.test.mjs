import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { writeGeneratedModule } from "../bundle-codex-appserver-bridge.mjs";

async function withScratch(run) {
  const scratch = await mkdtemp(join(tmpdir(), "write-generated-module-"));
  try {
    await run(scratch);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

test("writes a missing module, creating its directory", () =>
  withScratch(async (scratch) => {
    const path = join(scratch, "generated", "bundle.ts");
    writeGeneratedModule(path, "export const A = 1;\n");
    assert.equal(await readFile(path, "utf8"), "export const A = 1;\n");
    assert.deepEqual(await readdir(join(scratch, "generated")), ["bundle.ts"]);
  }));

test("leaves an unchanged module untouched", () =>
  withScratch(async (scratch) => {
    const path = join(scratch, "bundle.ts");
    await writeFile(path, "export const A = 1;\n");
    const past = new Date("2020-01-01T00:00:00Z");
    await utimes(path, past, past);
    writeGeneratedModule(path, "export const A = 1;\n");
    assert.equal((await stat(path)).mtimeMs, past.getTime());
  }));

test("replaces a stale module and leaves no temp file behind", () =>
  withScratch(async (scratch) => {
    const path = join(scratch, "bundle.ts");
    await writeFile(path, "export const A = 1;\n");
    writeGeneratedModule(path, "export const A = 2;\n");
    assert.equal(await readFile(path, "utf8"), "export const A = 2;\n");
    assert.deepEqual(await readdir(scratch), ["bundle.ts"]);
  }));
