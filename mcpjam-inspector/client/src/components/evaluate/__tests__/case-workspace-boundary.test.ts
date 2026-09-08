import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const workspaceDir = join(
  dirname(fileURLToPath(import.meta.url)),
  "../case-workspace",
);

function listFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? listFiles(path) : [path];
  });
}

describe("case-workspace boundary", () => {
  it("does not import test-template-editor internals", () => {
    const files = listFiles(workspaceDir).filter((path) =>
      /\.(ts|tsx)$/.test(path),
    );
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const source = readFileSync(file, "utf8");
      expect(source, file).not.toMatch(/test-template-editor/);
    }
  });
});
