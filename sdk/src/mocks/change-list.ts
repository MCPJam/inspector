import { canonicalJson } from "../contract/canonical.js";
import { mockPathOf } from "./change-kinds.js";
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

/**
 * What a change is about. A resource is grouped by its address: `skill://` is
 * a skill file and `ui://` an app, as a reader thinks of them.
 */
export type MockChangeTarget =
  | "server"
  | "tool"
  | "prompt"
  | "resource"
  | "resourceTemplate"
  | "skill"
  | "app";

export interface MockChange {
  target: MockChangeTarget;
  /** The name, URI or URI template a client sees; absent for the server. */
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
  if (path === "answer.from") {
    const by = after === "saved" ? "saved answers" : "the real tool";
    return gone
      ? `Went back to calling the real tool for ${q}`
      : `Made ${q} answer from ${by}`;
  }
  if (path === "answer.cases")
    return gone
      ? `Removed the saved answers of ${q}`
      : `Changed the saved answers of ${q}`;
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
  const {
    tools: _beforeTools,
    prompts: _beforePrompts,
    resources: _beforeResources,
    resourceTemplates: _beforeTemplates,
    ...beforeServer
  } = before ?? {};
  const {
    tools: _afterTools,
    prompts: _afterPrompts,
    resources: _afterResources,
    resourceTemplates: _afterTemplates,
    ...afterServer
  } = after;
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
  changes.push(
    ...diffItems("prompt", before?.prompts, after.prompts, () => "prompt"),
    ...diffItems("resource", before?.resources, after.resources, (uri) =>
      uri.startsWith("skill://")
        ? "skill"
        : uri.startsWith("ui://")
          ? "app"
          : "resource"
    ),
    ...diffItems(
      "resource template",
      before?.resourceTemplates,
      after.resourceTemplates,
      () => "resourceTemplate"
    )
  );
  return changes;
}

const itemSpread = (path: string) => /^(annotations|_meta)$/.test(path);

function describeItem(
  noun: string,
  path: string,
  kind: MockChangeKind,
  key: string
): string {
  const q = `"${key}"`;
  const gone = kind === "removed";
  if (path === "hidden")
    return gone ? `Showed the ${noun} ${q} again` : `Hid the ${noun} ${q}`;
  const what =
    path === "text" || path === "blob"
      ? "content"
      : path.replace(/([A-Z])/g, " $1").toLowerCase();
  return gone
    ? `Went back to the real ${what} of the ${noun} ${q}`
    : `Changed the ${what} of the ${noun} ${q}`;
}

/** The changes to one of the keyed maps (prompts, resources, templates), by key, sorted. */
function diffItems(
  noun: string,
  before: Record<string, object> | undefined,
  after: Record<string, object> | undefined,
  targetOf: (key: string) => Exclude<MockChangeTarget, "server" | "tool">
): MockChange[] {
  const out: MockChange[] = [];
  const keys = new Set([
    ...Object.keys(before ?? {}),
    ...Object.keys(after ?? {}),
  ]);
  for (const key of [...keys].sort()) {
    const b = before?.[key];
    const a = after?.[key];
    const details = diffFlat(
      flatten(b, itemSpread, new Map()),
      flatten(a, itemSpread, new Map()),
      (path, kind) => describeItem(noun, path, kind, key)
    );
    if (details.length === 0) continue;
    out.push({
      target: targetOf(key),
      name: key,
      kind: b === undefined ? "added" : a === undefined ? "removed" : "changed",
      summary: joined(details),
      details,
    });
  }
  return out;
}

/**
 * One change: a tool, prompt, resource or template the definition adds, edits
 * or hides, or one server-wide setting (instructions, serverInfo,
 * capabilities, pageSize). This is the unit every count and page of the
 * authoring reads uses. `path` addresses the change from the definition's root
 * (`tools.search`, `instructions`); `fields` are the leaf paths inside it, which
 * a field read or a patch can take. The entry's name sits in `name`, so a name
 * with dots in it is not read as a path.
 */
export interface ChangeEntry {
  path: string;
  target: MockChangeTarget;
  /** The tool, prompt, resource or template a client sees; absent for a server-wide setting. */
  name?: string;
  fields: string[];
  /** One sentence a person can read. */
  summary: string;
}

/** Every change the definition states, in the change list's order: server settings, then tools by name, then the other families. */
export function changeEntries(definition: MockDefinition): ChangeEntry[] {
  return diffMockDefinitions(undefined, definition).flatMap((change): ChangeEntry[] => {
    if (change.target !== "server") {
      return [
        {
          path: mockPathOf(change, "").replace(/\.$/, ""),
          target: change.target,
          ...(change.name === undefined ? {} : { name: change.name }),
          fields: change.details.map((detail) => detail.path),
          summary: change.summary,
        },
      ];
    }
    const bySetting = new Map<string, MockFieldChange[]>();
    for (const detail of change.details) {
      const setting = detail.path.split(".")[0] as string;
      bySetting.set(setting, [...(bySetting.get(setting) ?? []), detail]);
    }
    return [...bySetting].map(([setting, details]) => ({
      path: setting,
      target: "server" as const,
      fields: details.map((detail) => detail.path),
      summary: details.map((detail) => detail.summary).join(". "),
    }));
  });
}
