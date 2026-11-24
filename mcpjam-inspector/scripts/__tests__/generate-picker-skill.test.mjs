import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { generatedModule } from "../generate-picker-skill.mjs";

test("the picker's skill text is the climb skill as it stands now", () => {
  const generated = readFileSync(new URL("../../server/services/climbs/picker-skill.generated.ts", import.meta.url), "utf8");
  assert.equal(generated, generatedModule(), "run node scripts/generate-picker-skill.mjs");
});

test("the text carries the method and both references, and no frontmatter", () => {
  const text = generatedModule();
  assert.match(text, /What never to read/);
  assert.match(text, /Reading a round/);
  assert.match(text, /# climb-an-mcp-server/);
  assert.doesNotMatch(text, /^name: climb-an-mcp-server/m);
});
