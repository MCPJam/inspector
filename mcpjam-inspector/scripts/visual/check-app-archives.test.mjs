import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { checkAppArchives } from "./check-app-archives.mjs";

test("rejects zero archives and a theme overwritten by a duplicate title", () => {
  const directory = mkdtempSync(join(tmpdir(), "visual-archive-check-"));
  try {
    assert.throws(
      () => checkAppArchives(directory),
      /one application archive per screen and theme/,
    );
    writeFileSync(
      join(directory, "app.stories.json"),
      JSON.stringify({ stories: [{ name: "dark" }] }),
    );
    assert.throws(
      () => checkAppArchives(directory),
      /one application archive per screen and theme/,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("rejects failed resource archives before allowing upload", () => {
  const directory = mkdtempSync(join(tmpdir(), "visual-archive-errors-"));
  try {
    for (let index = 0; index < 6; index++)
      writeFileSync(join(directory, `${index}.stories.json`), "{}");
    mkdirSync(join(directory, "archive"));
    writeFileSync(join(directory, "archive/errors.json"), "{}");
    assert.throws(() => checkAppArchives(directory), /Resource archive errors/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
