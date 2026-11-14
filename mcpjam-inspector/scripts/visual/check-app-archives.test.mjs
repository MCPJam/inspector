import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  APPLICATION_SCREEN_COUNT,
  APPLICATION_SCREENS,
  checkAppArchives,
} from "./check-app-archives.mjs";

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
    for (let index = 0; index < APPLICATION_SCREEN_COUNT * 2; index++)
      writeFileSync(join(directory, `${index}.stories.json`), "{}");
    mkdirSync(join(directory, "archive"));
    writeFileSync(join(directory, "archive/errors.json"), "{}");
    assert.throws(() => checkAppArchives(directory), /Resource archive errors/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("requires every named screen and its matching DOM snapshot", () => {
  const directory = mkdtempSync(join(tmpdir(), "visual-complete-"));
  try {
    mkdirSync(join(directory, "archive"));
    for (const theme of ["light", "dark"])
      for (const [file, prefix, screens] of APPLICATION_SCREENS)
        for (const screen of screens) {
          const slug = screen.replaceAll(" ", "-");
          const id = `${file}-${prefix}-${theme}-${slug}`;
          writeFileSync(
            join(directory, `${id}.stories.json`),
            JSON.stringify({
              title: `${file}/${prefix} ${theme}: ${screen}`,
              stories: [
                {
                  name: slug,
                  globals: { viewport: "w1440h900" },
                  parameters: { chromatic: { colorScheme: theme } },
                },
              ],
            }),
          );
          writeFileSync(
            join(directory, "archive", `${id}-${slug}.w1440h900.snapshot.json`),
            "{}",
          );
        }
    checkAppArchives(directory);
    const last = APPLICATION_SCREENS.at(-1);
    const slug = last[2][0].replaceAll(" ", "-");
    rmSync(
      join(
        directory,
        "archive",
        `${last[0]}-${last[1]}-light-${slug}-${slug}.w1440h900.snapshot.json`,
      ),
    );
    assert.throws(() => checkAppArchives(directory), /ENOENT/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
