import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  JsonInputContext,
} from "../src/lib/json-input.js";
import { CliError } from "../src/lib/output.js";

const tempDirectories: string[] = [];

test.after(async () => {
  await Promise.all(
    tempDirectories.map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

async function writeJson(contents: string): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "mcpjam-json-input-"));
  tempDirectories.push(directory);
  const filePath = path.join(directory, "input.json");
  await writeFile(filePath, contents, "utf8");
  return filePath;
}

test("parseJsonInputRecord accepts inline JSON and @file", async () => {
  const context = new JsonInputContext();
  assert.deepEqual(context.parseJsonInputRecord('{"a":1}', "Params"), { a: 1 });

  const filePath = await writeJson('{"fromFile":true}\n');
  assert.deepEqual(context.parseJsonInputRecord(`@${filePath}`, "Params"), {
    fromFile: true,
  });
});

test("parseJsonInputValue accepts non-object JSON values", async () => {
  const context = new JsonInputContext();
  const filePath = await writeJson('"hello"\n');

  assert.equal(
    context.parseJsonInputValue(`@${filePath}`, "Tool output"),
    "hello",
  );
});

test("parseJsonInputRecord rejects invalid JSON, missing files, and non-objects", async () => {
  const context = new JsonInputContext();
  assert.throws(
    () => context.parseJsonInputRecord("{", "Params"),
    (error) =>
      error instanceof CliError && error.message.includes("must be valid JSON"),
  );
  assert.throws(
    () => context.parseJsonInputRecord("@", "Params"),
    (error) =>
      error instanceof CliError &&
      error.message.includes("file path is required"),
  );
  assert.throws(
    () => context.parseJsonInputRecord("@/definitely/missing.json", "Params"),
    (error) =>
      error instanceof CliError &&
      error.message.includes("Failed to read Params file"),
  );

  const filePath = await writeJson("[1,2,3]\n");
  assert.throws(
    () => context.parseJsonInputRecord(`@${filePath}`, "Params"),
    (error) =>
      error instanceof CliError &&
      error.message.includes("must be a JSON object"),
  );
});

test("parseJsonInputRecord rejects empty JSON input", async () => {
  const context = new JsonInputContext();
  const filePath = await writeJson("\n");

  assert.throws(
    () => context.parseJsonInputRecord(`@${filePath}`, "Params"),
    (error) =>
      error instanceof CliError && error.message.includes("input is empty"),
  );
});

test("parseJsonInputValue rejects duplicate stdin consumers", () => {
  const context = new JsonInputContext(() => '{"ok":true}');

  assert.deepEqual(context.parseJsonInputValue("-", "First"), { ok: true });
  assert.throws(
    () => context.parseJsonInputValue("-", "Second"),
    (error) =>
      error instanceof CliError &&
      error.message.includes("stdin was already consumed by First"),
  );
});

test("parseJsonInputValue wraps stdin read failures", () => {
  const context = new JsonInputContext(() => {
    throw new Error("EAGAIN");
  });

  assert.throws(
    () => context.parseJsonInputValue("-", "Params"),
    (error) =>
      error instanceof CliError &&
      error.message.includes("Failed to read Params from stdin"),
  );
});
