import { init, parse } from "es-module-lexer";
import { minify } from "terser";
import type { Plugin } from "vite";

function lexes(code: string): boolean {
  try {
    parse(code);
    return true;
  } catch {
    return false;
  }
}

// Terser's own name sequence, minus `of`. `mangle.reserved` cannot do this job:
// it stops terser handing `of` out, but it also stops terser renaming a
// binding that is ALREADY called `of`, which is exactly what esbuild left
// behind. Terser skips reserved words ("do", "if", ...) and asks for the next
// index, so answering with one withholds `of` without leaving a gap.
const LEADING = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ$_";
const TRAILING = LEADING + "0123456789";
const namesWithoutOf = {
  get(index: number): string {
    let name = "";
    let n = index + 1;
    let chars = LEADING;
    do {
      n--;
      name += chars[n % chars.length];
      n = Math.floor(n / chars.length);
      chars = TRAILING;
    } while (n > 0);
    return name === "of" ? "do" : name;
  },
};

/**
 * Keeps esbuild as the minifier while making the build immune to the
 * es-module-lexer bug that once made it fail at random.
 *
 * Vite bundles a copy of es-module-lexer 1.7.0 into its own dist, and
 * `vite:build-import-analysis` lexes every emitted chunk in `generateBundle`.
 * That version misreads `of` followed by `/` inside a `for (...)` as the start
 * of a regex literal, so valid minified code such as
 *
 *     var of = 2, h = 4; for (of / h; ; ) break;
 *
 * fails the whole build with a bare "Parse error @:1:1". Nothing in the repo
 * writes that; a minifier does, whenever it happens to hand out `of` as a
 * variable name.
 *
 * Minifying everything with terser (which can reserve `of`) fixed it, but made
 * `build:client` about 2.5x slower on every surface that builds the client:
 * npm, both desktop builds and the Railway image. Instead, this hook runs after
 * esbuild's minify (`order: "post"`) and before `generateBundle`. It lexes each
 * chunk with the same lexer version; only a chunk that fails is re-mangled
 * with terser, which renames every local and never hands out `of`. Chunks that lex cleanly (every chunk, on
 * every build so far) pay only the lex, which takes milliseconds.
 *
 * `needsRemangle` is injectable so a test can drive the fallback path; the
 * re-mangled output is always checked with the real lexer.
 */
export function lexerSafeMinify(
  options: { needsRemangle?: (code: string) => boolean } = {},
): Plugin {
  const needsRemangle = options.needsRemangle ?? ((code) => !lexes(code));

  return {
    name: "mcpjam:lexer-safe-minify",
    apply: "build",
    renderChunk: {
      order: "post",
      async handler(code, chunk, outputOptions) {
        await init;
        if (!needsRemangle(code)) return null;

        this.warn(
          `${chunk.fileName} trips the es-module-lexer \`of\` bug; re-mangling it with terser`,
        );
        const result = await minify(code, {
          compress: false,
          mangle: { nth_identifier: namesWithoutOf },
          module: outputOptions.format.startsWith("es"),
          toplevel: outputOptions.format === "cjs",
          sourceMap: true,
        });
        if (result.code === undefined || !lexes(result.code)) {
          this.error(
            `${chunk.fileName} still fails es-module-lexer after re-mangling without \`of\``,
          );
        }
        return { code: result.code, map: result.map as string };
      },
    },
  };
}
