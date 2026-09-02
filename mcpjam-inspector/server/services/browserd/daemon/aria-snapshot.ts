/**
 * Parse Playwright's aria-snapshot YAML into the `A11yNode` tree the L9 budget
 * is written against.
 *
 * WHY THIS EXISTS: `page.accessibility.snapshot()` — the tree-shaped API the
 * driver was originally written for — WAS REMOVED FROM PLAYWRIGHT. It is gone
 * from the pinned playwright-core 1.62.1 (no `accessibility` on `Page`, in the
 * types or the bundle), so `page.accessibility?.snapshot()` resolved
 * `undefined` on every call and `browser_observe({mode:"a11y"})` answered an
 * empty tree for every page. `locator.ariaSnapshot()` is its supported
 * successor and takes a selector root natively, which is also what makes the
 * L9 omission marker's `rootSelector` retrieval verb real.
 *
 * What it answers is YAML, not a tree, so we rebuild one. Reconstructing the
 * structure — rather than handing the model the YAML as flat text — is what
 * keeps `capA11yTree`'s omit-don't-truncate guarantee: a budget can only drop
 * WHOLE subtrees if it can see where a subtree ends.
 *
 * The grammar Playwright emits (default mode):
 *
 *     - banner:
 *       - heading "Welcome" [level=1]
 *       - link "Home":
 *         - /url: /home
 *     - main:
 *       - text: Hello world
 *       - paragraph: |
 *           a long
 *           multi-line run
 *
 * TOLERANCE IS THE POINT. This is a text format from a dependency we pin but
 * do not control, read at observation time on arbitrary pages. A line this
 * parser does not recognise becomes a text node rather than an exception:
 * degrading one node is a smaller failure than an observation that throws and
 * tells the model nothing about the page.
 */
import type { A11yNode } from "./observation-budget";

/** A parsed line, before nesting is resolved. */
interface ParsedLine {
  indent: number;
  node: A11yNode;
  /** The line ended in `:` — a container, or the head of a block scalar. */
  opensChildren: boolean;
  /** `|` / `|-` block scalar: following deeper lines are this node's text. */
  blockScalar: boolean;
}

/**
 * `role "name" [attr=value] [flag]` — role and the quoted name, which may
 * contain escaped quotes. Attributes are parsed separately off the tail.
 */
const ROLE_LINE = /^([^\s":]+)(?:\s+"((?:[^"\\]|\\.)*)")?\s*(.*)$/;
const ATTRIBUTE = /\[([^\]=]+)(?:=([^\]]*))?\]/g;

/**
 * Rebuild an `A11yNode` tree from Playwright's aria-snapshot YAML.
 *
 * Returns the single top-level node when the snapshot has exactly one (the
 * usual shape when scoped to a `rootSelector`), a synthetic `document` node
 * wrapping them when a page yields several, and `null` for an empty snapshot.
 */
export function parseAriaSnapshot(yaml: string | null | undefined): A11yNode | null {
  if (!yaml) return null;
  const lines = yaml.split("\n");
  const roots: A11yNode[] = [];
  // Each entry owns the node opened at that indent, so a line's parent is the
  // deepest entry indented less than it.
  const stack: { indent: number; node: A11yNode }[] = [];

  for (let index = 0; index < lines.length; index += 1) {
    const raw = lines[index];
    if (raw.trim().length === 0) continue;
    const parsed = parseLine(raw);
    if (!parsed) continue;

    while (stack.length > 0 && stack[stack.length - 1].indent >= parsed.indent) {
      stack.pop();
    }
    const parent = stack[stack.length - 1];
    if (parent) {
      (parent.node.children ??= []).push(parsed.node);
    } else {
      roots.push(parsed.node);
    }

    if (parsed.blockScalar) {
      // Consume the indented run that carries this node's text, and skip the
      // lines so their leading `-`-less content is never read as structure.
      const { text, next } = readBlockScalar(lines, index + 1, parsed.indent);
      if (text) parsed.node.name = text;
      index = next - 1;
      continue;
    }
    if (parsed.opensChildren) {
      stack.push({ indent: parsed.indent, node: parsed.node });
    }
  }

  if (roots.length === 0) return null;
  if (roots.length === 1) return roots[0];
  return { role: "document", children: roots };
}

/** Parse one `- …` entry. Returns null for a line that is not an entry. */
function parseLine(raw: string): ParsedLine | null {
  const indent = raw.length - raw.trimStart().length;
  const trimmed = raw.trim();
  if (!trimmed.startsWith("- ") && trimmed !== "-") return null;
  let body = trimmed.slice(1).trim();
  if (body.length === 0) return null;

  const opensChildren = body.endsWith(":");
  if (opensChildren) body = body.slice(0, -1).trimEnd();

  // `text: hello`, `/url: /home` — a property line, whose value is the name.
  // Checked before the role form so a colon-carrying key is never mistaken
  // for a role with a stray suffix.
  const property = matchProperty(body);
  if (property) {
    if (property.value === "|" || property.value === "|-") {
      return {
        indent,
        node: { role: property.key },
        opensChildren: false,
        blockScalar: true,
      };
    }
    return {
      indent,
      node: { role: property.key, name: property.value },
      opensChildren: false,
      blockScalar: false,
    };
  }

  const match = ROLE_LINE.exec(body);
  if (!match) {
    // Unrecognised: keep the content as text rather than dropping a node the
    // model may need. See the tolerance note above.
    return {
      indent,
      node: { role: "text", name: body },
      opensChildren,
      blockScalar: false,
    };
  }
  const [, role, name, tail] = match;
  const node: A11yNode = { role };
  if (name !== undefined) node.name = unescapeName(name);
  applyAttributes(node, tail);
  return { indent, node, opensChildren, blockScalar: false };
}

/** Split `key: value`, where the key is unquoted and colon-free. */
function matchProperty(body: string): { key: string; value: string } | null {
  const colon = body.indexOf(": ");
  const bare = body.endsWith(":") ? body.length - 1 : -1;
  const at = colon >= 0 ? colon : bare;
  if (at <= 0) return null;
  const key = body.slice(0, at);
  if (key.includes('"') || key.includes(" ")) return null;
  return { key, value: body.slice(at + 1).trim() };
}

/**
 * Fold `[level=1]` / `[checked]` onto the node. Numeric values are stored as
 * numbers and a bare flag as `true`, so a consumer reads a value rather than
 * re-parsing the bracket syntax.
 */
function applyAttributes(node: A11yNode, tail: string): void {
  if (!tail) return;
  for (const match of tail.matchAll(ATTRIBUTE)) {
    const key = match[1].trim();
    if (!key) continue;
    const value = match[2];
    if (value === undefined) {
      node[key] = true;
      continue;
    }
    const trimmed = value.trim();
    const numeric = Number(trimmed);
    node[key] = trimmed !== "" && Number.isFinite(numeric) ? numeric : trimmed;
  }
}

/** `\"` and `\\` are the escapes Playwright emits inside a quoted name. */
function unescapeName(name: string): string {
  return name.replace(/\\(["\\])/g, "$1");
}

/**
 * Read the indented run belonging to a `|` block scalar, starting at `from`.
 * Returns the dedented text and the index of the first line after the block.
 */
function readBlockScalar(
  lines: readonly string[],
  from: number,
  parentIndent: number,
): { text: string; next: number } {
  const collected: string[] = [];
  let cursor = from;
  let blockIndent: number | null = null;
  while (cursor < lines.length) {
    const line = lines[cursor];
    if (line.trim().length === 0) {
      collected.push("");
      cursor += 1;
      continue;
    }
    const indent = line.length - line.trimStart().length;
    if (indent <= parentIndent) break;
    blockIndent ??= indent;
    collected.push(line.slice(Math.min(blockIndent, indent)));
    cursor += 1;
  }
  // Trailing blank lines are YAML padding, not content.
  while (collected.length > 0 && collected[collected.length - 1] === "") {
    collected.pop();
  }
  return { text: collected.join("\n"), next: cursor };
}
