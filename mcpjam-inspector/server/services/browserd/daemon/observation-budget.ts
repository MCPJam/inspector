/**
 * L9 — omit, don't truncate.
 *
 * A model reading a truncated structure cannot tell a missing field from a
 * cut-off one: `{"user":{"name":"ada","emai` is worse than useless, because it
 * looks like data. So structured payloads (the a11y tree, WebMCP tool lists)
 * are reduced by dropping WHOLE subtrees and saying so, with the verb that
 * retrieves the dropped part; only flat text (console lines, tool output
 * strings) is byte-truncated, where a cut is unambiguous and the tail is
 * genuinely less interesting than the head.
 *
 * Pure policy, no browser: every budget here is unit-tested directly.
 */

/** A node of the accessibility tree, as Playwright's snapshot yields it. */
export interface A11yNode {
  role?: string;
  name?: string;
  value?: string | number;
  description?: string;
  children?: A11yNode[];
  [key: string]: unknown;
}

export interface A11yBudget {
  /** Total nodes the returned tree may contain. */
  maxNodes: number;
  /** Depth past which a subtree is omitted wholesale. */
  maxDepth: number;
}

export const DEFAULT_A11Y_BUDGET: A11yBudget = { maxNodes: 400, maxDepth: 12 };

export interface CappedA11yTree {
  tree: A11yNode | null;
  /** How many subtrees were omitted (each replaced by a marker node). */
  omittedSubtrees: number;
  /** Total nodes in the ORIGINAL tree, so the caller can say how much is missing. */
  totalNodes: number;
}

function countNodes(node: A11yNode): number {
  let total = 1;
  for (const child of node.children ?? []) total += countNodes(child);
  return total;
}

/**
 * A marker that REPLACES an omitted subtree. It names the verb that fetches
 * it, because "there is more here" without "and this is how you get it" just
 * teaches a model to guess.
 */
function omissionMarker(node: A11yNode, hiddenNodes: number): A11yNode {
  const label = node.name ? `${node.role ?? "node"} "${node.name}"` : (node.role ?? "node");
  return {
    role: "omitted",
    name:
      `${hiddenNodes} node(s) under ${label} omitted — re-observe with ` +
      `{mode:"a11y", rootSelector:"<selector for this element>"} to read this subtree`,
  };
}

/**
 * Cap an a11y tree by omitting whole subtrees, breadth-first: shallow
 * structure (which orients the model) survives, deep detail is dropped with a
 * marker. Never returns a partially-serialized node.
 */
export function capA11yTree(
  root: A11yNode | null | undefined,
  budget: A11yBudget = DEFAULT_A11Y_BUDGET,
): CappedA11yTree {
  if (!root) return { tree: null, omittedSubtrees: 0, totalNodes: 0 };
  const totalNodes = countNodes(root);
  let remaining = Math.max(1, budget.maxNodes);
  let omittedSubtrees = 0;

  const visit = (node: A11yNode, depth: number): A11yNode => {
    remaining -= 1;
    const { children, ...rest } = node;
    if (!children || children.length === 0) return { ...rest };
    // Depth or budget exhausted ⇒ the ENTIRE child list goes, as one marker.
    if (depth >= budget.maxDepth || remaining <= 0) {
      omittedSubtrees += 1;
      const hidden = children.reduce((sum, child) => sum + countNodes(child), 0);
      return { ...rest, children: [omissionMarker(node, hidden)] };
    }
    const kept: A11yNode[] = [];
    for (let index = 0; index < children.length; index += 1) {
      if (remaining <= 0) {
        // Budget ran out mid-list: the REST of the siblings go as one marker,
        // so the model sees "there were more children", never a silent cut.
        omittedSubtrees += 1;
        const hidden = children
          .slice(index)
          .reduce((sum, child) => sum + countNodes(child), 0);
        kept.push(omissionMarker(node, hidden));
        break;
      }
      kept.push(visit(children[index], depth + 1));
    }
    return { ...rest, children: kept };
  };

  return { tree: visit(root, 0), omittedSubtrees, totalNodes };
}

/** The suffix a byte-truncated flat string carries, so a cut is never silent. */
export const TRUNCATION_SUFFIX = "\n…[truncated]";

/**
 * Byte-truncate FLAT text (console lines, a tool's string output). Unlike a
 * structure, a cut string is unambiguous — and the marker says so explicitly.
 * Counts UTF-8 BYTES (not code units) and never splits a multi-byte character.
 */
export function capText(text: string, maxBytes: number): string {
  const encoder = new TextEncoder();
  const bytes = encoder.encode(text);
  if (bytes.byteLength <= maxBytes) return text;
  const suffixBytes = encoder.encode(TRUNCATION_SUFFIX).byteLength;
  const keep = Math.max(0, maxBytes - suffixBytes);
  // `TextDecoder` with `fatal: false` replaces a split character with U+FFFD,
  // so back up to a character boundary first: if the byte we would cut AT is a
  // continuation byte (0b10xxxxxx), the cut lands mid-character.
  let end = Math.min(keep, bytes.byteLength);
  while (end > 0 && (bytes[end] & 0b1100_0000) === 0b1000_0000) end -= 1;
  const decoder = new TextDecoder("utf-8");
  return decoder.decode(bytes.subarray(0, end)) + TRUNCATION_SUFFIX;
}

export interface ConsoleEntry {
  type: string;
  text: string;
  /** ms since epoch, so a model can tell "just now" from "before my last act". */
  at: number;
}

export interface ConsoleBudget {
  /** Newest N entries; console history is a tail, not a document. */
  maxEntries: number;
  /** Per-entry byte cap (a single stack trace can be enormous). */
  maxEntryBytes: number;
}

export const DEFAULT_CONSOLE_BUDGET: ConsoleBudget = {
  maxEntries: 50,
  maxEntryBytes: 2_000,
};

/** Take the NEWEST entries within budget, each byte-capped. */
export function capConsole(
  entries: readonly ConsoleEntry[],
  budget: ConsoleBudget = DEFAULT_CONSOLE_BUDGET,
): { entries: ConsoleEntry[]; omitted: number } {
  const kept = entries.slice(-budget.maxEntries);
  return {
    entries: kept.map((entry) => ({
      ...entry,
      text: capText(entry.text, budget.maxEntryBytes),
    })),
    omitted: Math.max(0, entries.length - kept.length),
  };
}

/**
 * Cap a WebMCP tool invocation's output. An object is returned whole when it
 * fits and REPLACED by a descriptive marker when it does not — never
 * half-serialized, for the same reason a11y subtrees are omitted rather than
 * cut. A string is byte-truncated, since that cut is unambiguous.
 */
export function capToolOutput(
  output: unknown,
  maxBytes: number,
): { output: unknown; omitted: boolean } {
  if (typeof output === "string") {
    const capped = capText(output, maxBytes);
    return { output: capped, omitted: capped !== output };
  }
  let serialized: string;
  try {
    serialized = JSON.stringify(output) ?? "null";
  } catch {
    return {
      output: "[output could not be serialized]",
      omitted: true,
    };
  }
  if (new TextEncoder().encode(serialized).byteLength <= maxBytes) {
    return { output, omitted: false };
  }
  return {
    output:
      `[tool output omitted: ${serialized.length} chars exceeds the ` +
      `${maxBytes}-byte budget — have the page return a smaller result, or ` +
      `read the rendered page instead]`,
    omitted: true,
  };
}
