/**
 * Syntax trees for the rules that must tell code from comments, strings,
 * regex literals and JSX text, which a text match cannot. This is the
 * TypeScript parser alone: no program and no types, a few milliseconds a
 * file.
 *
 * `typescript` loads on the first parse, so a script that only imports
 * `isMeasuredFile` (pr-size) still runs without node_modules. CI jobs that
 * count rules install the package on its own; see slop-ratchet.yml.
 */
import { createRequire } from "node:module";

let ts;
let last = {};

/** The `typescript` module, loaded on first use. */
export function typescript() {
  ts ??= createRequire(import.meta.url)("typescript");
  return ts;
}

/**
 * `text` parsed as the file at `path`, which picks TS, TSX or JS. The last
 * tree is reused because every rule reads the same file in turn.
 */
export function parse(path, text) {
  if (last.path !== path || last.text !== text) {
    const { createSourceFile, ScriptTarget } = typescript();
    last = {
      path,
      text,
      tree: createSourceFile(path, text, ScriptTarget.Latest, true),
    };
  }
  return last.tree;
}

/** Calls `visit` on every node under `tree`, parents before children. */
export function walk(tree, visit) {
  const { forEachChild } = typescript();
  const step = (node) => {
    visit(node);
    forEachChild(node, step);
  };
  forEachChild(tree, step);
}
