/**
 * The mock that puts the old values back. A verification runs the real server
 * (now running the kept changes) beside a mock in front of it that states, for
 * every field a kept change touched, the value the real server had before: that
 * pair is the baseline measured now, beside the server as it is.
 *
 * A mock can state a field and cannot take one away, and it cannot bring back a
 * tool the new code removed, so those changes come back as `unrestorable` and
 * the verification runs the server alone, setting its result beside the one the
 * climb recorded.
 */
import type { MockChange } from "./change-list.js";
import type { MockDefinition, MockTool } from "./definition-types.js";

/** What the real server held before the climb changed anything. */
export type OldServer = {
  instructions?: string;
  serverInfo?: { name?: string; title?: string; version?: string };
  tools: Record<string, Partial<Record<(typeof RESTORABLE)[number], unknown>>>;
  /** Paths the stored capture dropped for size, such as `tools.search.inputSchema`: their old values are unknown. */
  droppedFields?: readonly string[];
};

export type Unrestorable = { path: string; why: string };
export type InverseMock = { definition: MockDefinition; unrestorable: Unrestorable[] };

const RESTORABLE = ["title", "description", "outputSchema", "annotations", "icons", "inputSchema"] as const;
type Restorable = (typeof RESTORABLE)[number];

function isRestorable(head: string): head is Restorable {
  return (RESTORABLE as readonly string[]).includes(head);
}

/** The inverse of a kept change list: the definition that states the old values, and what it could not. */
export function inverseOfChanges(changes: readonly MockChange[], old: OldServer): InverseMock {
  const tools: Record<string, MockTool> = {};
  const serverInfo: Record<string, string> = {};
  let instructions: string | undefined;
  const unrestorable: Unrestorable[] = [];
  const dropped = new Set(old.droppedFields ?? []);
  const cannot = (path: string, why: string) => {
    if (!unrestorable.some((entry) => entry.path === path)) unrestorable.push({ path, why });
  };

  for (const change of changes) {
    for (const detail of change.details) {
      if (change.target === "server") {
        const path = detail.path;
        if (path === "instructions") {
          if (old.instructions === undefined || dropped.has("instructions")) cannot(path, "the server had no instructions before, or their old text was not stored");
          else instructions = old.instructions;
        } else if (path.startsWith("serverInfo.")) {
          const key = path.slice("serverInfo.".length);
          const value = old.serverInfo?.[key as "name" | "title" | "version"];
          if (value === undefined) cannot(path, `the old ${key} is not known`);
          else serverInfo[key] = value;
        } else {
          cannot(path, "a mock cannot put back what the server declared before");
        }
        continue;
      }
      const name = change.name ?? "";
      if (change.target !== "tool") {
        cannot(`${change.target}.${name}.${detail.path}`, `a mock cannot yet put back an edit to the ${change.target} "${name}"`);
        continue;
      }
      const path = `tools.${name}.${detail.path}`;
      const before = old.tools[name];
      const head = detail.path.split(".")[0] ?? "";
      if (!before) {
        cannot(path, `the tool "${name}" did not exist before, so the new code's version of it cannot be put back`);
      } else if (head === "hidden") {
        cannot(path, `the new code removed the tool "${name}", and a mock cannot list a tool the server no longer has`);
      } else if (head === "answer") {
        cannot(path, `the new code renamed or remapped "${name}", and a mock cannot reverse that`);
      } else if (isRestorable(head) || head === "params") {
        // Hidden or fixed parameters were the mock's way of changing the input: the old schema is what comes back.
        const field: Restorable = head === "params" ? "inputSchema" : (head as Restorable);
        const value = before[field];
        if (value === undefined || dropped.has(`tools.${name}.${field}`)) {
          cannot(path, `the old ${field} of "${name}" ${value === undefined ? "was not set, and a mock cannot take a field away" : "was not stored"}`);
        } else {
          tools[name] = { ...tools[name], [field]: value };
        }
      } else {
        cannot(path, `a mock cannot put back ${detail.path} of "${name}"`);
      }
    }
  }
  return {
    definition: {
      ...(instructions !== undefined ? { instructions } : {}),
      ...(Object.keys(serverInfo).length > 0 ? { serverInfo } : {}),
      ...(Object.keys(tools).length > 0 ? { tools } : {}),
    },
    unrestorable,
  };
}
