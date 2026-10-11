import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export function checkAppArchives(directory) {
  const files = readdirSync(directory).filter((name) =>
    name.endsWith(".stories.json"),
  );
  assert.equal(
    files.length,
    14,
    "Expected one application archive per screen and theme",
  );
  assert.equal(
    existsSync(join(directory, "archive/errors.json")),
    false,
    "Resource archive errors",
  );
  for (const theme of ["light", "dark"]) {
    for (const [file, prefix, screens] of [
      ["app", "inspector", ["connections", "add-server", "playground"]],
      [
        "product",
        "product",
        ["project-overview", "tools-result", "chat-app", "eval-failure"],
      ],
    ])
      for (const screen of screens) {
        const id = `${file}-${prefix}-${theme}-${screen}`;
        const archive = JSON.parse(
          readFileSync(join(directory, `${id}.stories.json`), "utf8"),
        );
        assert.equal(archive.title, `${file}/${prefix} ${theme}: ${screen}`);
        assert.equal(archive.stories.length, 1, "Unexpected snapshot count");
        const story = archive.stories[0];
        assert.equal(story.name, screen);
        assert.equal(story.parameters.chromatic.colorScheme, theme);
        assert.equal(story.globals.viewport, "w1440h900");
        const snapshot = join(
          directory,
          "archive",
          `${id}-${story.name}.w1440h900.snapshot.json`,
        );
        assert.ok(
          JSON.parse(readFileSync(snapshot, "utf8")),
          "Missing DOM snapshot",
        );
      }
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  checkAppArchives(
    process.argv[2] ?? ".playwright/visual-results/chromatic-archives",
  );
  process.stdout.write(
    "Verified 14 application snapshots across 7 screens in light and dark.\n",
  );
}
