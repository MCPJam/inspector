import { diffLines, diffWordsWithSpace } from "diff";

/**
 * Turns the before/after values of one changed field into rows a git-style
 * view can draw. The backend decides *which* fields changed
 * (`diffServerSnapshot` in mcpjam-backend); this only lays out *how*.
 */

export type DiffSegment = { text: string; changed: boolean };

export type DiffLine =
  | { kind: "context"; text: string }
  | { kind: "removed" | "added"; segments: DiffSegment[] }
  | { kind: "gap"; count: number };

/** An empty `lines` means only whitespace changed. */
export type FieldDiff =
  | { kind: "inline"; before?: string; after?: string }
  | { kind: "lines"; lines: DiffLine[] };

/**
 * `inline` reads `old → new` and suits short identifiers (a version, a
 * title). `text` is prose, diffed by line with changed words marked.
 * `json` is pretty-printed with sorted keys, then diffed like `text`.
 */
export type FieldDiffMode = "inline" | "text" | "json";

/**
 * Snapshot shapes, mirrored by hand from mcpjam-backend `serverToolSnapshot.ts`
 * and narrowed to the fields read here by name.
 */
export interface SnapshotTool {
  name: string;
  description?: string;
  meta?: unknown;
  /** Pre-v3 snapshots stored `_meta` here. */
  metadata?: unknown;
  [field: string]: unknown;
}

export interface SnapshotDiscovery {
  serverInfo?: Record<string, unknown>;
  [field: string]: unknown;
}

const TOOL_FIELD_MODES: Record<string, FieldDiffMode> = {
  title: "inline",
  description: "text",
};

const DISCOVERY_FIELD_MODES: Record<string, FieldDiffMode> = {
  resultType: "inline",
  protocolVersion: "inline",
  "serverInfo.name": "inline",
  "serverInfo.title": "inline",
  "serverInfo.version": "inline",
  "serverInfo.websiteUrl": "inline",
  "serverInfo.description": "text",
  instructions: "text",
};

export function diffToolField(
  before: SnapshotTool | undefined,
  after: SnapshotTool | undefined,
  field: string,
): FieldDiff {
  // The backend diff reads `meta` with the same legacy fallback.
  const read = (tool?: SnapshotTool) =>
    field === "meta" ? (tool?.meta ?? tool?.metadata) : tool?.[field];
  return diffFieldValues(
    read(before),
    read(after),
    TOOL_FIELD_MODES[field] ?? "json",
  );
}

/** `field` is the backend's name for it, e.g. `serverInfo.version`. */
export function diffDiscoveryField(
  before: SnapshotDiscovery | undefined,
  after: SnapshotDiscovery | undefined,
  field: string,
): FieldDiff {
  const serverInfoKey = field.match(/^serverInfo\.(.+)$/)?.[1];
  const read = (discovery?: SnapshotDiscovery) =>
    serverInfoKey === undefined
      ? discovery?.[field]
      : discovery?.serverInfo?.[serverInfoKey];
  return diffFieldValues(
    read(before),
    read(after),
    DISCOVERY_FIELD_MODES[field] ?? "json",
  );
}

/**
 * Storage drops oversized parts of a snapshot and logs each path (see the
 * backend's `redactForInlineStorage`), and a dropped side would otherwise
 * read as a deletion. Returns the revision that dropped `path` or a parent.
 */
export function revisionMissing(
  sides: ReadonlyArray<
    { revisionNumber: number; droppedFields?: string[] } | null | undefined
  >,
  path: string,
): number | undefined {
  return sides.find((side) =>
    side?.droppedFields?.some(
      (dropped) => path === dropped || path.startsWith(`${dropped}.`),
    ),
  )?.revisionNumber;
}

const CONTEXT_LINES = 3;
/** Below this share of shared characters, marking words is just noise. */
const MIN_SHARED_FOR_WORD_MARKS = 0.3;

export function diffFieldValues(
  before: unknown,
  after: unknown,
  mode: FieldDiffMode,
): FieldDiff {
  if (mode === "inline") {
    return {
      kind: "inline",
      before: formatInline(before),
      after: formatInline(after),
    };
  }
  const format = (value: unknown) =>
    value === undefined || value === null
      ? ""
      : mode === "text" && typeof value === "string"
        ? value
        : (JSON.stringify(canonicalize(value), null, 2) ?? "");
  return { kind: "lines", lines: diffTextLines(format(before), format(after)) };
}

/**
 * Mirrors the backend's `normalizeForHash`: keys sorted, and the set-like
 * `required` array sorted, so a reorder the backend ignores never shows up
 * here as a change.
 */
function canonicalize(value: unknown, parentKey?: string): unknown {
  if (Array.isArray(value)) {
    const mapped = value.map((entry) => canonicalize(entry));
    const primitives = mapped.every(
      (entry) => entry === null || typeof entry !== "object",
    );
    return parentKey === "required" && primitives
      ? [...mapped].sort((left, right) =>
          JSON.stringify(left).localeCompare(JSON.stringify(right)),
        )
      : mapped;
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, canonicalize(entry, key)]),
    );
  }
  return value;
}

function formatInline(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "string") return value;
  return JSON.stringify(canonicalize(value));
}

function splitLines(value: string): string[] {
  const lines = value.split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

type Op = { kind: "context" | "removed" | "added"; text: string };

function diffTextLines(before: string, after: string): DiffLine[] {
  if (before === after) return [];
  // A missing final newline would otherwise make the last line differ.
  const withEol = (value: string) =>
    value === "" || value.endsWith("\n") ? value : `${value}\n`;
  const ops: Op[] = diffLines(withEol(before), withEol(after)).flatMap((part) =>
    splitLines(part.value).map((text) => ({
      kind: part.added ? "added" : part.removed ? "removed" : "context",
      text,
    })),
  );
  if (!ops.some((op) => op.kind !== "context")) return [];
  return collapseContext(markChangedWords(ops));
}

/**
 * jsdiff emits a replaced block as its removed lines, then its added lines.
 * Pair them up in order and mark the words that differ within each pair.
 */
function markChangedWords(ops: Op[]): DiffLine[] {
  const lines: DiffLine[] = [];
  let index = 0;
  while (index < ops.length) {
    const op = ops[index];
    if (op.kind === "context") {
      lines.push({ kind: "context", text: op.text });
      index += 1;
      continue;
    }
    const removed: string[] = [];
    while (ops[index]?.kind === "removed") removed.push(ops[index++].text);
    const added: string[] = [];
    while (ops[index]?.kind === "added") added.push(ops[index++].text);

    const removedLines: DiffLine[] = removed.map((text) => ({
      kind: "removed",
      segments: [{ text, changed: false }],
    }));
    const addedLines: DiffLine[] = added.map((text) => ({
      kind: "added",
      segments: [{ text, changed: false }],
    }));
    const pairs = Math.min(removed.length, added.length);
    for (let pair = 0; pair < pairs; pair += 1) {
      const marked = wordSegments(removed[pair], added[pair]);
      if (marked) {
        removedLines[pair] = { kind: "removed", segments: marked.before };
        addedLines[pair] = { kind: "added", segments: marked.after };
      }
    }
    lines.push(...removedLines, ...addedLines);
  }
  return lines;
}

function wordSegments(
  before: string,
  after: string,
): { before: DiffSegment[]; after: DiffSegment[] } | undefined {
  const parts = diffWordsWithSpace(before, after);
  const shared = parts
    .filter((part) => !part.added && !part.removed)
    .reduce((total, part) => total + part.value.length, 0);
  const longest = Math.max(before.length, after.length, 1);
  if (shared / longest < MIN_SHARED_FOR_WORD_MARKS) return undefined;
  return {
    before: parts
      .filter((part) => !part.added)
      .map((part) => ({ text: part.value, changed: part.removed })),
    after: parts
      .filter((part) => !part.removed)
      .map((part) => ({ text: part.value, changed: part.added })),
  };
}

/** Keep a few unchanged lines around each change, like `git diff -U3`. */
function collapseContext(lines: DiffLine[]): DiffLine[] {
  const output: DiffLine[] = [];
  let index = 0;
  while (index < lines.length) {
    if (lines[index].kind !== "context") {
      output.push(lines[index]);
      index += 1;
      continue;
    }
    let end = index;
    while (end < lines.length && lines[end].kind === "context") end += 1;
    const run = lines.slice(index, end);
    const keepHead = index === 0 ? 0 : CONTEXT_LINES;
    const keepTail = end === lines.length ? 0 : CONTEXT_LINES;
    if (run.length <= keepHead + keepTail + 1) {
      output.push(...run);
    } else {
      output.push(...run.slice(0, keepHead));
      output.push({ kind: "gap", count: run.length - keepHead - keepTail });
      output.push(...run.slice(run.length - keepTail));
    }
    index = end;
  }
  return output;
}
