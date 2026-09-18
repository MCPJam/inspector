import { describe, expect, it } from "vitest";
import { init, parse } from "es-module-lexer";
import { lexerSafeMinify } from "../../../vite-lexer-safe-minify";

// The minimal chunk es-module-lexer 1.7.0 rejects: `of` followed by `/`
// inside a `for (...)` is misread as the start of a regex literal.
const TRIPS_LEXER =
  "var of = 2, h = 4; for (of / h; ; ) break; export { of as value };";

async function runRenderChunk(
  plugin: ReturnType<typeof lexerSafeMinify>,
  code: string,
) {
  const hook = plugin.renderChunk as {
    handler: (...args: unknown[]) => Promise<unknown>;
  };
  const warnings: string[] = [];
  const context = {
    warn: (message: string) => warnings.push(message),
    error: (message: string) => {
      throw new Error(message);
    },
  };
  const result = await hook.handler.call(
    context,
    code,
    { fileName: "assets/index.js" },
    { format: "es" },
  );
  return { result: result as { code: string; map: unknown } | null, warnings };
}

function lexes(code: string) {
  try {
    parse(code);
    return true;
  } catch {
    return false;
  }
}

describe("lexerSafeMinify", () => {
  it("runs after the minifier, only in builds", () => {
    const plugin = lexerSafeMinify();
    expect(plugin.apply).toBe("build");
    expect((plugin.renderChunk as { order: string }).order).toBe("post");
  });

  it("leaves a chunk the lexer accepts untouched", async () => {
    const { result, warnings } = await runRenderChunk(
      lexerSafeMinify(),
      "var xz = 2, h = 4; for (xz / h; ; ) break; export { xz as value };",
    );
    expect(result).toBeNull();
    expect(warnings).toEqual([]);
  });

  it("re-mangles a chunk that trips the lexer so the build can lex it", async () => {
    await init;
    expect(lexes(TRIPS_LEXER)).toBe(false);

    const { result, warnings } = await runRenderChunk(
      lexerSafeMinify(),
      TRIPS_LEXER,
    );

    expect(result).not.toBeNull();
    expect(lexes(result!.code)).toBe(true);
    expect(result!.code).not.toMatch(/\bof\b/);
    // The export name is public API and must survive the re-mangle.
    expect(parse(result!.code)[1].map((e) => e.n)).toEqual(["value"]);
    expect(JSON.parse(result!.map as string)).toMatchObject({
      mappings: expect.any(String),
    });
    expect(warnings).toHaveLength(1);
  });
});
