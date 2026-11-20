import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { createVariantInput } from "../src/commands/variants.js";
import { JsonInputContext } from "../src/lib/json-input.js";

const EDIT = {
  feature: "tools.description",
  target: "show_servers",
  op: "set",
  value: "Lists every server with its health.",
};

/** `--edits` read through the real JSON input path, with `@file` stubbed. */
function input(edits: string, files: Record<string, string> = {}) {
  return createVariantInput(
    { server: "base", edits, label: "sweep 8" },
    new JsonInputContext((path) => {
      const contents = files[String(path)];
      if (contents === undefined) throw new Error(`no file ${String(path)}`);
      return contents;
    }),
  );
}

describe("mcpjam cloud variants create", () => {
  test("reads --edits as JSON, inline or from a file", () => {
    const parsed = input(JSON.stringify([EDIT]));
    assert.equal(parsed.server, "base");
    assert.deepEqual(parsed.edits, [EDIT]);
    assert.equal(parsed.label, "sweep 8");
    assert.deepEqual(
      input("@edits.json", { "edits.json": JSON.stringify([EDIT]) }).edits,
      [EDIT],
    );
  });

  test("refuses edits the operation would refuse, before sending anything", () => {
    assert.throws(() => input("[]"), {
      message:
        'edits: A variant needs at least one edit. Pass --edits as a JSON array like [{"feature": "tools.description", "target": "<tool>", "op": "set", "value": "<description>"}].',
    });
    assert.throws(
      () => input(JSON.stringify([{ ...EDIT, value: 7 }])),
      /edits\.0\.value/,
    );
  });
});
