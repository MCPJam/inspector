import { readFile } from "node:fs/promises";
import path from "node:path";
import { compile } from "@tailwindcss/node";
import { Scanner } from "@tailwindcss/oxide";
import { expect, it } from "vitest";

it("ships fullscreen and PiP styles from the widget package", async () => {
  const stylesheet = path.resolve(__dirname, "../index.css");
  const base = path.dirname(stylesheet);
  const compiler = await compile(await readFile(stylesheet, "utf8"), {
    base,
    onDependency: () => {},
  });
  // Only use explicit external sources: classes found elsewhere in the app
  // must not accidentally mask an unscanned widget package.
  const scanner = new Scanner({ sources: compiler.sources });
  const candidates = scanner.scan();
  expect(scanner.files).toContain(
    path.resolve(base, "../../../widget-react/src/mcp-apps-renderer.tsx"),
  );
  const css = compiler.build(candidates);
  expect(css).toMatch(/\.z-40\s*\{\s*z-index:\s*40;/);
  expect(css).toContain("max-width: min(90vw, 1200px)");
});
