import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { transform } from "esbuild";
import type { Plugin } from "vite";

/** Relative to the Vite root, which `vite.config.ts` sets to the client directory. */
const SOURCE_PATH = "src/lib/meticulous-middleware.ts";
const RECORDER_TAG = /<script\b[^>]*\bdata-recording-token=[^>]*><\/script>/;

/** The middleware source as one classic script: an IIFE with no imports or exports. */
export async function compileMeticulousMiddleware(
  sourcePath: string,
): Promise<string> {
  const source = readFileSync(sourcePath, "utf8");
  const { code } = await transform(source, {
    loader: "ts",
    format: "iife",
    target: "es2019",
    minify: true,
    sourcemap: false,
  });
  return code;
}

/** Places `tag` directly after the recorder's script tag, or leaves `html` alone when there is none. */
export function injectAfterRecorder(html: string, tag: string): string {
  const match = RECORDER_TAG.exec(html);
  if (!match) return html;
  const end = match.index + match[0].length;
  return html.slice(0, end) + tag + html.slice(end);
}

/**
 * Loads `src/lib/meticulous-middleware.ts` right after the Meticulous
 * recorder tag, so the recorder stays the first script and the middleware is
 * installed before its first upload. Built as a same-origin asset so the
 * report-only CSP's `script-src 'self'` covers it without a nonce; the dev
 * server inlines it because nothing emits assets there. Register it only when
 * the recorder plugin is registered.
 */
export function meticulousMiddleware(): Plugin {
  let base = "/";
  let command: "build" | "serve" = "build";
  let sourcePath = SOURCE_PATH;
  let assetPath: string | undefined;
  let inlineSource: string | undefined;
  return {
    name: "mcpjam:meticulous-middleware",
    configResolved(config) {
      base = config.base;
      command = config.command;
      sourcePath = path.resolve(config.root, SOURCE_PATH);
    },
    async buildStart() {
      const code = await compileMeticulousMiddleware(sourcePath);
      if (command === "serve") {
        inlineSource = code;
        return;
      }
      const hash = createHash("sha256").update(code).digest("hex").slice(0, 8);
      assetPath = `assets/meticulous-middleware-${hash}.js`;
      this.emitFile({ type: "asset", fileName: assetPath, source: code });
    },
    transformIndexHtml: {
      order: "post",
      handler(html) {
        const tag = assetPath
          ? `<script src="${base}${assetPath}"></script>`
          : inlineSource
          ? `<script>${inlineSource}</script>`
          : undefined;
        return tag ? injectAfterRecorder(html, tag) : html;
      },
    },
  };
}
