/**
 * Observational tool-route keys.
 *
 * Lifted from the backend usage-insights trajectory helper so evals can
 * describe "the same route in k of N trials" without importing Convex.
 * `search,search,get` collapses to `search→get`. The backend copy is a
 * follow-up `check:mirrors` candidate.
 */

export const PATH_SEPARATOR = "→";

/** Sentinel `pathKey` for a trial that never called a tool. */
export const NO_TOOL_PATH_KEY = "no_tools";

/** Collapse immediately-repeated names; `[]` in, `[]` out. */
export function collapseImmediateRepeats(names: string[]): string[] {
  const out: string[] = [];
  for (const name of names) {
    if (out[out.length - 1] === name) continue;
    out.push(name);
  }
  return out;
}

/** `pathKey` for an already-ordered tool-name sequence. */
export function buildPathKey(toolCallSequence: string[]): string {
  const collapsed = collapseImmediateRepeats(toolCallSequence);
  if (collapsed.length === 0) return NO_TOOL_PATH_KEY;
  return collapsed.join(PATH_SEPARATOR);
}

/**
 * Recover the distinct tool names from a stored `pathKey`.
 * Returns `[]` for the no-tools sentinel.
 */
export function toolNamesFromPathKey(pathKey: string | undefined): string[] {
  if (!pathKey || pathKey === NO_TOOL_PATH_KEY) return [];
  return Array.from(
    new Set(
      pathKey
        .split(PATH_SEPARATOR)
        .map((name) => name.trim())
        .filter(Boolean)
    )
  );
}
