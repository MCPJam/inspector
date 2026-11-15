import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export const APPLICATION_SCREENS = [
  ["app", "inspector", ["connections", "add-server", "playground"]],
  [
    "product",
    "product",
    ["project-overview", "tools-result", "chat-app", "eval-failure"],
  ],
  ["swarm", "product", ["swarm-overview", "swarm-personas", "swarm-sessions"]],
  ["tool-errors", "product", ["tool-error"]],
  ["swarm-authoring", "product", ["swarm-empty", "swarm-create"]],
  [
    "task-accounts",
    "product",
    ["task account panel", "task form input", "task url input"],
  ],
];
export const APPLICATION_SCREEN_COUNT = APPLICATION_SCREENS.reduce(
  (count, [, , screens]) => count + screens.length,
  0,
);

export function checkAppArchives(directory) {
  const files = readdirSync(directory).filter((name) =>
    name.endsWith(".stories.json"),
  );
  assert.equal(
    files.length,
    APPLICATION_SCREEN_COUNT * 2,
    "Expected one application archive per screen and theme",
  );
  assert.equal(
    existsSync(join(directory, "archive/errors.json")),
    false,
    "Resource archive errors",
  );
  for (const theme of ["light", "dark"]) {
    for (const [file, prefix, screens] of APPLICATION_SCREENS)
      for (const screen of screens) {
        const slug = screen.replaceAll(" ", "-");
        const id = `${file}-${prefix}-${theme}-${slug}`;
        const archive = JSON.parse(
          readFileSync(join(directory, `${id}.stories.json`), "utf8"),
        );
        assert.equal(archive.title, `${file}/${prefix} ${theme}: ${screen}`);
        assert.equal(archive.stories.length, 1, "Unexpected snapshot count");
        const story = archive.stories[0];
        assert.equal(story.name, slug);
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
    `Verified ${APPLICATION_SCREEN_COUNT * 2} application snapshots across ${APPLICATION_SCREEN_COUNT} screens in light and dark.\n`,
  );
}
