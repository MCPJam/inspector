/**
 * The Claude Code bridge bundle indents with one tab per level. Patch needles
 * are quoted from it two spaces per level, the way they read in review, and
 * this restores the bundle's indentation, so a needle still has to match the
 * vendor's bytes exactly. Replacements go through it too: later patches anchor
 * on earlier patches' output.
 */
export function bridgeIndent(source: string): string {
  return source.replace(/^(?: {2})+/gm, (indent) =>
    "\t".repeat(indent.length / 2),
  );
}
