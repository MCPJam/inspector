import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  parseJsonInputRecord,
  parseJsonInputValue,
  resetJsonInputStdinForTests,
} from "../src/lib/json-input.js";
import { CliError } from "../src/lib/output.js";

async function writeJson(contents: string): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "mcpjam-json-input-"));
  const filePath = path.join(directory, "input.json");
  await writeFile(filePath, contents, "utf8");
  return filePath;
}

test("parseJsonInputRecord accepts inline JSON and @file", async () => {
  resetJsonInputStdinForTests();
  assert.deepEqual(parseJsonInputRecord('{"a":1}', "Params"), { a: 1 });

  const filePath = await writeJson('{"fromFile":true}\n');
  assert.deepEqual(parseJsonInputRecord(`@${filePath}`, "Params"), {
    fromFile: true,
  });
});

test("parseJsonInputValue accepts non-object JSON values", async () => {
  resetJsonInputStdinForTests();
  const filePath = await writeJson('"hello"\n');

  assert.equal(parseJsonInputValue(`@${filePath}`, "Tool output"), "hello");
});

test("parseJsonInputRecord rejects invalid JSON, missing files, and non-objects", async () => {
  resetJsonInputStdinForTests();
  assert.throws(
    () => parseJsonInputRecord("{", "Params"),
    (error) =>
      error instanceof CliError && error.message.includes("must be valid JSON"),
  );
  assert.throws(
    () => parseJsonInputRecord("@", "Params"),
    (error) =>
      error instanceof CliError &&
      error.message.includes("file path is required"),
  );
  assert.throws(
    () => parseJsonInputRecord("@/definitely/missing.json", "Params"),
    (error) =>
      error instanceof CliError &&
      error.message.includes("Failed to read Params file"),
  );

  const filePath = await writeJson("[1,2,3]\n");
  assert.throws(
    () => parseJsonInputRecord(`@${filePath}`, "Params"),
    (error) =>
      error instanceof CliError &&
      error.message.includes("must be a JSON object"),
  );
});
