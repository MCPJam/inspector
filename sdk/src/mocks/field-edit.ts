/**
 * Changes one path of a definition: an entry, one of its fields, or a nested
 * path inside a field. The caller names what to set (or remove) and nothing
 * else, so a late entry of a large mock is patched without reading or sending
 * the rest.
 */
import type { MockDefinition } from "./definition-types.js";

export const MOCK_FAMILIES = [
  "tools",
  "prompts",
  "resources",
  "resourceTemplates",
] as const;
export type MockFamily = (typeof MOCK_FAMILIES)[number];

export interface MockFieldEdit {
  /** With `name`, the entry's family; without both, `path` starts at the definition's root. */
  family?: MockFamily;
  /** The tool or prompt name, resource URI or template a client sees. */
  name?: string;
  /** Inside the entry (or inside the definition without a family). Empty with a name edits the whole entry. */
  path?: string[];
  /** Set the path to this. */
  value?: unknown;
  /** Remove the path, so the real server's own value shows again. */
  remove?: boolean;
}

export type MockFieldEditResult =
  | { ok: true; definition: MockDefinition; path: string[] }
  | { ok: false; message: string };

const UNSAFE = new Set(["__proto__", "constructor", "prototype"]);

type Obj = Record<string, unknown>;
const isObj = (value: unknown): value is Obj =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** The definition path an edit names: `[family, name, ...path]`, or `path` alone. */
export function editPath(edit: MockFieldEdit): string[] | string {
  if (edit.family === undefined && edit.name !== undefined) {
    return "Give `family` with `name`: tools, prompts, resources or resourceTemplates.";
  }
  if (edit.family !== undefined && !edit.name) {
    return "Give the entry's `name` with `family`. A tool or prompt name, a resource URI or a template.";
  }
  const inside = edit.path ?? [];
  const path =
    edit.family === undefined
      ? inside
      : [edit.family, edit.name as string, ...inside];
  if (path.length === 0) {
    return "Give a `path` to change, or a `family` and `name`.";
  }
  if (path.some((segment) => segment === "" || UNSAFE.has(segment))) {
    return `Every part of the path must be a non-empty key; "${path.join(".")}" is not.`;
  }
  return path;
}

/** The definition with the edit applied; the input is not changed. */
export function applyFieldEdit(
  definition: MockDefinition,
  edit: MockFieldEdit
): MockFieldEditResult {
  const path = editPath(edit);
  if (typeof path === "string") return { ok: false, message: path };
  if (edit.remove === true) {
    if (edit.value !== undefined) {
      return { ok: false, message: "Give `value` or `remove`, not both." };
    }
  } else if (edit.value === undefined) {
    return { ok: false, message: "Give the new `value`, or `remove` to drop the path." };
  }
  const root: Obj = structuredClone(definition) as Obj;
  const parents: Obj[] = [root];
  let at: Obj = root;
  for (const [i, key] of path.slice(0, -1).entries()) {
    const next = at[key];
    if (next === undefined && edit.remove !== true) {
      at[key] = {};
    } else if (!isObj(next)) {
      return {
        ok: false,
        message:
          next === undefined
            ? `${path.slice(0, i + 1).join(".")} is not set, so there is nothing to remove under it.`
            : `${path.slice(0, i + 1).join(".")} is not an object, so it has no "${path[i + 1]}". Patch ${path.slice(0, i + 1).join(".")} itself.`,
      };
    }
    at = at[key] as Obj;
    parents.push(at);
  }
  const last = path[path.length - 1] as string;
  if (edit.remove === true) {
    delete at[last];
    // An entry left empty states nothing: drop it up the chain.
    for (let i = parents.length - 1; i > 0; i--) {
      if (Object.keys(parents[i] as Obj).length > 0) break;
      delete (parents[i - 1] as Obj)[path[i - 1] as string];
    }
  } else {
    at[last] = edit.value;
  }
  return { ok: true, definition: root as MockDefinition, path };
}
