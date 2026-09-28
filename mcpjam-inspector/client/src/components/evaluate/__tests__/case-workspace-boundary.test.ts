import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));

/**
 * The Evaluate case surface, as three folders that may not reach into the
 * 4.4k-line editor they are mounted by. The editor passes them props; they
 * never read its internals, which is what keeps them testable on their own
 * and what makes the eventual extraction possible at all.
 */
const boundedDirs = [
  join(here, "../case-workspace"),
  join(here, "../case-scorecard"),
  join(here, "../case-spine"),
  join(here, "../simple-case"),
];

function listFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? listFiles(path) : [path];
  });
}

describe("case surface boundary", () => {
  it("does not import test-template-editor internals", () => {
    const files = boundedDirs
      .flatMap((dir) => listFiles(dir))
      .filter((path) => /\.(ts|tsx)$/.test(path));
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const source = readFileSync(file, "utf8");
      expect(source, file).not.toMatch(/test-template-editor/);
    }
  });
});
