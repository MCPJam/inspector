import { canonicalJson } from "../contract/index.js";
import type { JsonValue, MockDefinition } from "./definition-types.js";

export type MockChangeKind = "added" | "removed" | "changed";

export interface MockFieldChange {
  /** Dotted path inside the entry, e.g. `description` or `params.limit.fixed`. */
  path: string;
  kind: MockChangeKind;
  before?: JsonValue;
  after?: JsonValue;
  /** One sentence a person can read. */
  summary: string;
}

export interface MockChange {
  target: "server" | "tool";
  /** The tool's name as a client sees it; absent for the server. */
  name?: string;
  kind: MockChangeKind;
  summary: string;
  details: MockFieldChange[];
}

type Flat = Map<string, JsonValue>;

/**
 * Splits an entry into the fields a reader thinks of as one edit each:
 * annotations and `_meta` by key, `params` by parameter field, `answer` by key.
 */
function flatten(
  entry: object | undefined,
  spread: (path: string) => boolean,
  into: Flat,
  prefix = ""
): Flat {
  for (const [key, value] of Object.entries(entry ?? {})) {
    const path = prefix + key;
    if (spread(path) && typeof value === "object" && value !== null) {
      flatten(value, spread, into, `${path}.`);
    } else {
      into.set(path, value as JsonValue);
    }
  }
  return into;
}

const serverSpread = (path: string) =>
  path === "serverInfo" || path === "capabilities";
const toolSpread = (path: string) =>
  /^(annotations|_meta|answer|params(\.[^.]+)?)$/.test(path);

function describe(
  path: string,
  kind: MockChangeKind,
  name: string,
  after: JsonValue | undefined
): string {
  const q = `"${name}"`;
  const gone = kind === "removed";
  const [head, second, third] = path.split(".");
  if (head === "hidden")
    return gone ? `Showed the tool ${q} again` : `Hid the tool ${q}`;
  if (head === "params") {
    const p = `the parameter "${second}" of ${q}`;
    if (third === "hidden") return gone ? `Showed ${p} again` : `Hid ${p}`;
    if (third === "fixed") return gone ? `Stopped fixing ${p}` : `Fixed ${p}`;
    return gone
      ? `Went back to the real description of ${p}`
      : `Rewrote the description of ${p}`;
  }
  if (path === "answer.tool") {
    return gone
      ? `Pointed ${q} back at the real tool of the same name`
      : `Pointed ${q} at the real tool "${String(after)}"`;
  }
  if (path === "answer.arguments")
    return gone
      ? `Stopped fixing arguments on ${q}`
      : `Fixed arguments on ${q}`;
  const words = path.replace(/([A-Z])/g, " $1").toLowerCase();
  return gone
    ? `Went back to the real ${words} of ${q}`
    : `Changed the ${words} of ${q}`;
}

function diffFlat(
  before: Flat,
  after: Flat,
  summary: (path: string, kind: MockChangeKind, after?: JsonValue) => string
): MockFieldChange[] {
  const out: MockFieldChange[] = [];
  for (const path of [...new Set([...before.keys(), ...after.keys()])].sort()) {
    const b = before.get(path);
    const a = after.get(path);
    if (
      b !== undefined &&
      a !== undefined &&
      canonicalJson(b) === canonicalJson(a)
    )
      continue;
    const kind: MockChangeKind =
      b === undefined ? "added" : a === undefined ? "removed" : "changed";
    out.push({
      path,
      kind,
      ...(b === undefined ? {} : { before: b }),
      ...(a === undefined ? {} : { after: a }),
      summary: summary(path, kind, a),
    });
  }
  return out;
}

const joined = (details: MockFieldChange[]) =>
  details.map((d) => d.summary).join(". ");

/**
 * A structural diff of two definitions: one entry per thing that changed, with
 * the fields behind it, readable by a person and by an agent. The server's
 * fields come first, then tools by name. `before` may be undefined for a first
 * version. Entries match by key, so a rename shows as one entry added and, when
 * the old name was hidden, one hidden.
 */
export function diffMockDefinitions(
  before: MockDefinition | undefined,
  after: MockDefinition
): MockChange[] {
  const changes: MockChange[] = [];
  const { tools: _beforeTools, ...beforeServer } = before ?? {};
  const { tools: _afterTools, ...afterServer } = after;
  const server = diffFlat(
    flatten(beforeServer, serverSpread, new Map()),
    flatten(afterServer, serverSpread, new Map()),
    (path, kind) =>
      kind === "removed"
        ? `Went back to the real server's ${path}`
        : `Changed the server's ${path}`
  );
  if (server.length > 0) {
    changes.push({
      target: "server",
      kind: "changed",
      summary: joined(server),
      details: server,
    });
  }
  const names = new Set([
    ...Object.keys(before?.tools ?? {}),
    ...Object.keys(after.tools ?? {}),
  ]);
  for (const name of [...names].sort()) {
    const b = before?.tools?.[name];
    const a = after.tools?.[name];
    const details = diffFlat(
      flatten(b, toolSpread, new Map()),
      flatten(a, toolSpread, new Map()),
      (path, kind, to) => describe(path, kind, name, to)
    );
    if (details.length === 0) continue;
    changes.push({
      target: "tool",
      name,
      kind: b === undefined ? "added" : a === undefined ? "removed" : "changed",
      summary: joined(details),
      details,
    });
  }
  return changes;
}
