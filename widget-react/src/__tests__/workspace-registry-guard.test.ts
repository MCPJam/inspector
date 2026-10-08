// @vitest-environment node
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, it } from "vitest";

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name === "__tests__") return [];
    const path = resolve(directory, entry.name);
    return entry.isDirectory()
      ? sourceFiles(path)
      : /\.tsx?$/.test(path) ? [path] : [];
  });
}

it("keeps widget and chat consumers on their workspace registry", () => {
  const roots = [
    resolve(import.meta.dirname, ".."),
    resolve(import.meta.dirname, "../../../mcpjam-inspector/client/src/hooks"),
  ];
  const offenders = roots.flatMap(sourceFiles).filter((path) =>
    /useApp(?:ToolsRegistry|ToolInvocationLog)\s*\.\s*getState\s*\(/.test(
      readFileSync(path, "utf8"),
    ),
  );
  expect(offenders).toEqual([]);
});
