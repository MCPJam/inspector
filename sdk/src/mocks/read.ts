/**
 * Bounded reads of a mock's definition: a page of the names in a family, one
 * entry, or one field or nested path of it, with an oversized string split
 * into ordered chunks. Every view is sized so its pretty-printed JSON (how the
 * MCP Worker returns it as tool text) fits `MOCK_READ_LIMIT`, which leaves the
 * rest of the Worker's 24,000-character budget for the project info and links
 * it adds. Paging is by offset; the host seals the offsets into cursors.
 *
 * What a reader sees is the effective entry (the real server's saved listing
 * with the definition laid over it) and what the definition itself states, so
 * an author finds the 202nd tool by name, sees its current description, and
 * patches that one path.
 */
import type { Tool } from "@modelcontextprotocol/server";
import { realToolNameFor } from "./definition-types.js";
import type { MockDefinition, MockTool } from "./definition-types.js";
import { MOCK_FAMILIES, type MockFamily } from "./field-edit.js";
import { MockCursorError } from "./read-cursor.js";
import { mergeTool } from "./resolve-tools.js";

/** The MCP Worker's limit on the text of one tool response, in characters. */
export const MOCK_TEXT_BUDGET = 24_000;
/** What a read may use: the Worker adds the project, links and indentation to the rest. */
export const MOCK_READ_LIMIT = 20_000;
/** The most JSON characters of one string a chunk carries. */
export const MOCK_CHUNK_LIMIT = 12_000;
export const MOCK_DEFAULT_PAGE = 50;
export const MOCK_MAX_PAGE = 200;

type Obj = Record<string, unknown>;
const isObj = (value: unknown): value is Obj =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** The text a surface returns for a payload. */
export const textSize = (value: unknown): number =>
  JSON.stringify(value, null, 2).length;

/** What the real server's saved listing holds, as the version pinned it. */
export interface MockListing {
  serverInfo?: Obj;
  instructions?: string;
  capabilities?: Obj;
  tools?: Tool[];
  prompts?: Obj[];
  resources?: Obj[];
  resourceTemplates?: Obj[];
}

export interface MockReadSource {
  definition: MockDefinition;
  listing?: MockListing;
}

export interface MockReadSelector {
  family?: MockFamily;
  name?: string;
  /** Inside the entry; without a family, inside the definition. */
  path?: string[];
  /** Names containing this text, any case. Lists only. */
  search?: string;
  limit?: number;
}

export interface MockPage {
  offset: number;
  count: number;
  total: number;
  /** True on the last page; otherwise `nextCursor` continues. */
  end: boolean;
  nextCursor?: string;
  /** `characters` when the page is a chunk of one string. */
  unit?: "characters";
}

export interface MockPageHost {
  offset: number;
  /** A cursor that continues at an offset. */
  seal(offset: number): string;
  /** The identity fields that go out with the view, so their size counts. */
  envelope: Obj;
}

export type MockEntryKind = "real" | "edited" | "added";

export interface MockListItem {
  name: string;
  kind: MockEntryKind;
  hidden?: true;
  title?: string;
  description?: string;
}

const KEY: Record<MockFamily, string> = {
  tools: "name",
  prompts: "name",
  resources: "uri",
  resourceTemplates: "uriTemplate",
};

/** A selector that cannot be read, said so a caller can fix it; undefined when fine. */
export function readSelectorProblem(s: MockReadSelector): string | undefined {
  if (s.family === undefined && s.name !== undefined) {
    return "Give `family` with `name`: tools, prompts, resources or resourceTemplates.";
  }
  if (s.family === undefined && s.search !== undefined) {
    return "Give `family` to search: tools, prompts, resources or resourceTemplates.";
  }
  if (s.search !== undefined && s.name !== undefined) {
    return "Give `search` or `name`, not both: `search` lists names, `name` reads one entry.";
  }
  if (s.family !== undefined && s.name === undefined && s.path?.length) {
    return "Give the entry's `name` with `family` and `path`.";
  }
  return undefined;
}

interface Row {
  name: string;
  base?: Obj;
  stated?: Obj;
  effective: Obj;
}

const clip = (text: unknown, max: number): string | undefined =>
  typeof text === "string"
    ? text.length > max
      ? `${text.slice(0, max)}…`
      : text
    : undefined;

/** Every entry of a family: the real listing's, then the ones only the definition adds. */
function rowsOf(source: MockReadSource, family: MockFamily): Row[] {
  const stated = (source.definition[family] ?? {}) as Record<string, Obj>;
  const base = (source.listing?.[family] ?? []) as Obj[];
  const key = KEY[family];
  const byName = new Map(base.map((entry) => [String(entry[key]), entry]));
  const names = [...new Set([...byName.keys(), ...Object.keys(stated)])];
  return names.map((name) => {
    const entry = stated[name];
    // A renamed tool lists the real tool it points at.
    const real =
      family === "tools" && entry
        ? byName.get(realToolNameFor(name, entry as MockTool))
        : byName.get(name);
    let effective: Obj;
    if (family === "tools" && real) {
      effective = mergeTool(real as Tool, name, entry as MockTool) as Obj;
    } else {
      const { hidden: _hidden, answer: _answer, params: _params, ...rest } = entry ?? {};
      effective = { ...real, ...rest, [key]: name };
    }
    return {
      name,
      ...(real && { base: real }),
      ...(entry && { stated: entry }),
      effective,
    };
  });
}

/** Whole items of `items` from `offset`, as many as fit the limit and the budget. */
export function fitPage<T>(
  items: readonly T[],
  host: MockPageHost,
  limit: number | undefined,
  build: (page: T[], info: MockPage) => Obj
): Obj {
  const total = items.length;
  const offset = host.offset;
  if (offset > total) {
    throw new MockCursorError(
      "malformed",
      "That cursor points past the end of the list. Read again without a cursor."
    );
  }
  const most = Math.min(
    Math.max(1, Math.min(limit ?? MOCK_DEFAULT_PAGE, MOCK_MAX_PAGE)),
    total - offset
  );
  const make = (count: number): Obj => {
    const end = offset + count >= total;
    return build(items.slice(offset, offset + count), {
      offset,
      count,
      total,
      end,
      ...(!end && { nextCursor: host.seal(offset + count) }),
    });
  };
  let count = 0;
  while (count < most && (count === 0 || textSize({ ...host.envelope, ...make(count + 1) }) <= MOCK_READ_LIMIT)) {
    count += 1;
  }
  return make(count);
}

function listView(source: MockReadSource, s: MockReadSelector, host: MockPageHost): Obj {
  const family = s.family as MockFamily;
  const needle = s.search?.toLowerCase();
  const rows = rowsOf(source, family).filter(
    (row) => needle === undefined || row.name.toLowerCase().includes(needle)
  );
  return fitPage(rows, host, s.limit, (page, info) => ({
    view: "list",
    family,
    ...(s.search !== undefined && { search: s.search }),
    entries: page.map((row): MockListItem => {
      const hidden = row.stated?.hidden === true;
      return {
        name: row.name,
        kind: row.base ? (row.stated ? "edited" : "real") : "added",
        ...(hidden && { hidden: true as const }),
        ...(typeof row.effective.title === "string" && { title: clip(row.effective.title, 80) }),
        ...(typeof row.effective.description === "string" && { description: clip(row.effective.description, 160) }),
      };
    }),
    page: info,
  }));
}

const OMITTED = "$omitted";

/** A value with long strings, long lists and deep nesting replaced by markers that say where to read them. */
function shrink(
  value: unknown,
  path: string[],
  rule: { chars: number; depth: number; items: number }
): unknown {
  if (typeof value === "string") {
    return value.length > rule.chars ? { [OMITTED]: "string", length: value.length, path } : value;
  }
  if (typeof value !== "object" || value === null) return value;
  const list = Array.isArray(value);
  const entries: [string, unknown][] = list
    ? value.map((v, i) => [String(i), v])
    : Object.entries(value);
  if (path.length >= rule.depth) {
    return { [OMITTED]: list ? "array" : "object", length: entries.length, path };
  }
  const shown = entries.slice(0, rule.items).map(([k, v]) => [k, shrink(v, [...path, k], rule)] as const);
  const more = entries.length - shown.length;
  if (list) {
    const items = shown.map(([, v]) => v);
    return more > 0 ? [...items, { [OMITTED]: "array", length: more, from: shown.length, path }] : items;
  }
  return {
    ...Object.fromEntries(shown),
    ...(more > 0 && { [OMITTED]: `${more} more keys`, path }),
  };
}

/** Decreasing limits until the view fits; the last one only names what is there. */
const SHRINK_RULES = [
  { chars: 1500, depth: 8, items: 40 },
  { chars: 500, depth: 6, items: 20 },
  { chars: 160, depth: 4, items: 12 },
  { chars: 48, depth: 3, items: 8 },
  { chars: 0, depth: 1, items: 0 },
] as const;

function fitShrunk(host: MockPageHost, build: (rule: (typeof SHRINK_RULES)[number]) => Obj): Obj {
  let view = build(SHRINK_RULES[0]);
  for (const rule of SHRINK_RULES) {
    view = build(rule);
    if (textSize({ ...host.envelope, ...view }) <= MOCK_READ_LIMIT) break;
  }
  return view;
}

function entryView(source: MockReadSource, s: MockReadSelector, host: MockPageHost): Obj | undefined {
  const family = s.family as MockFamily;
  const row = rowsOf(source, family).find((r) => r.name === s.name);
  if (!row) return undefined;
  return fitShrunk(host, (rule) => ({
    view: "entry",
    family,
    name: row.name,
    kind: row.base ? (row.stated ? "edited" : "real") : "added",
    ...(row.stated && { stated: shrink(row.stated, [], rule) }),
    effective: shrink(row.effective, [], rule),
  }));
}

function lookup(root: unknown, path: string[]): { found: boolean; value?: unknown } {
  let at = root;
  for (const key of path) {
    if (Array.isArray(at) && /^\d+$/.test(key) && Number(key) < at.length) at = at[Number(key)];
    else if (isObj(at) && Object.hasOwn(at, key)) at = at[key];
    else return { found: false };
  }
  return { found: true, value: at };
}

/** The JSON characters one UTF-16 unit costs inside a string. */
function jsonCost(code: number): number {
  if (code < 0x20) return code === 8 || code === 9 || code === 10 || code === 12 || code === 13 ? 2 : 6;
  return code === 0x22 || code === 0x5c ? 2 : 1;
}

/** One chunk of a string from `offset`: whole characters, at most `limit` JSON characters. */
export function chunkText(text: string, offset: number, limit = MOCK_CHUNK_LIMIT): { chunk: string; end: number } {
  let i = offset;
  let cost = 0;
  while (i < text.length) {
    const code = text.charCodeAt(i);
    const pair = code >= 0xd800 && code <= 0xdbff && (text.charCodeAt(i + 1) & 0xfc00) === 0xdc00;
    const width = pair ? 2 : code >= 0xd800 && code <= 0xdfff ? 6 : jsonCost(code);
    if (cost + width > limit && i > offset) break;
    cost += width;
    i += pair ? 2 : 1;
  }
  return { chunk: text.slice(offset, i), end: i };
}

function valueView(source: MockReadSource, s: MockReadSelector, host: MockPageHost): Obj | undefined {
  const path = s.path ?? [];
  let statedRoot: unknown;
  let effectiveRoot: unknown;
  if (s.family === undefined) {
    statedRoot = source.definition;
    const { serverInfo, instructions, capabilities } = source.listing ?? {};
    effectiveRoot = { serverInfo, instructions, capabilities };
  } else {
    const row = rowsOf(source, s.family).find((r) => r.name === s.name);
    statedRoot = row?.stated;
    effectiveRoot = row?.effective;
  }
  const fromStated = lookup(statedRoot, path);
  const found = fromStated.found ? fromStated : lookup(effectiveRoot, path);
  if (!found.found) return undefined;
  const head = {
    view: "value",
    ...(s.family !== undefined && { family: s.family, name: s.name }),
    path,
    /** Whether the definition states this path, as against the real server's own value. */
    stated: fromStated.found,
  };
  const value = found.value;
  if (typeof value === "string") {
    if (host.offset > value.length) {
      throw new MockCursorError("malformed", "That cursor points past the end of the value. Read again without a cursor.");
    }
    const { chunk, end } = chunkText(value, host.offset);
    const done = end >= value.length;
    return {
      ...head,
      type: "string",
      value: chunk,
      page: {
        offset: host.offset,
        count: chunk.length,
        total: value.length,
        end: done,
        unit: "characters",
        ...(!done && { nextCursor: host.seal(end) }),
      } satisfies MockPage,
    };
  }
  return fitShrunk(host, (rule) => ({
    ...head,
    type: Array.isArray(value) ? "array" : value === null ? "null" : typeof value,
    value: shrink(value, path, rule),
  }));
}

/**
 * One bounded view of the definition for a selector: a list (a family, or a
 * search of it), an entry (family and name) or a value (a path). Returns
 * undefined when the named entry or path is not there. The summary, which is
 * what a read with no selector returns, is the host's: it needs identity and
 * policy this module does not have.
 */
export function readMockView(
  source: MockReadSource,
  selector: MockReadSelector,
  host: MockPageHost
): Obj | undefined {
  if (selector.family !== undefined && !MOCK_FAMILIES.includes(selector.family)) return undefined;
  if (selector.family !== undefined && selector.name === undefined) return listView(source, selector, host);
  if (selector.path?.length || (selector.family === undefined && selector.name === undefined)) {
    return valueView(source, selector, host);
  }
  return entryView(source, selector, host);
}
