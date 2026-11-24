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
import type { MockChange, MockChangeTarget } from "./change-list.js";
import { CHANGE_PLACES, mockPathOf } from "./change-kinds.js";
import type {
  MockDefinition,
  MockPrompt,
  MockResource,
  MockResourceTemplate,
  MockTool,
} from "./definition-types.js";

/** What the real server held before the climb changed anything. */
export type OldServer = {
  instructions?: string;
  serverInfo?: { name?: string; title?: string; version?: string };
  tools: Record<string, Partial<Record<(typeof RESTORABLE)[number], unknown>>>;
  /**
   * What the server listed before, by prompt name, resource URI (skills and
   * apps included) and URI template. A map left out was not stored: nothing
   * in it can be put back. An entry missing from a stored map did not exist.
   */
  prompts?: Record<string, Record<string, unknown>>;
  resources?: Record<string, Record<string, unknown>>;
  resourceTemplates?: Record<string, Record<string, unknown>>;
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

type ItemTarget = Exclude<MockChangeTarget, "server" | "tool">;

const PROMPT_FIELDS = ["title", "description", "arguments", "icons", "_meta", "messages"];
const TEMPLATE_FIELDS = ["name", "title", "description", "mimeType", "annotations", "icons", "_meta", "text", "blob"];
const RESOURCE_FIELDS = [...TEMPLATE_FIELDS, "size"];

/** The fields of a prompt, resource, template, skill file or app a mock can state again. */
const ITEM_FIELDS: Record<ItemTarget, readonly string[]> = {
  prompt: PROMPT_FIELDS,
  resource: RESOURCE_FIELDS,
  skill: RESOURCE_FIELDS,
  app: RESOURCE_FIELDS,
  resourceTemplate: TEMPLATE_FIELDS,
};

/** The inverse of a kept change list: the definition that states the old values, and what it could not. */
export function inverseOfChanges(changes: readonly MockChange[], old: OldServer): InverseMock {
  const tools: Record<string, MockTool> = {};
  const serverInfo: Record<string, string> = {};
  let instructions: string | undefined;
  const unrestorable: Unrestorable[] = [];
  const prompts: Record<string, Record<string, unknown>> = {};
  const resources: Record<string, Record<string, unknown>> = {};
  const templates: Record<string, Record<string, unknown>> = {};
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
        const place = CHANGE_PLACES[change.target];
        const path = mockPathOf(change, detail.path);
        const noun = `${place.noun.replace(/^the /, "")} "${name}"`;
        const restored = place.map === "prompts" ? prompts : place.map === "resourceTemplates" ? templates : resources;
        const head = detail.path.split(".")[0] ?? "";
        const stored = old[place.map as "prompts" | "resources" | "resourceTemplates"];
        if (head === "hidden") {
          // A mock can hide what the server lists, not list what the new code removed.
          if (detail.after === true) cannot(path, `the new code removed the ${noun}, and a mock cannot list what the server no longer has`);
          else restored[name] = { hidden: true };
        } else if (!ITEM_FIELDS[change.target].includes(head)) {
          cannot(path, `a mock cannot put back ${detail.path} of the ${noun}`);
        } else if (stored === undefined) {
          cannot(path, `the old ${noun} was not stored, so its old ${head} is not known`);
        } else if (stored[name] === undefined) {
          cannot(path, `the ${noun} did not exist before, so the new code's version of it cannot be put back`);
        } else if (stored[name][head] === undefined || dropped.has(path)) {
          cannot(path, `the old ${head} of the ${noun} ${stored[name][head] === undefined ? "was not set, and a mock cannot take a field away" : "was not stored"}`);
        } else if (restored[name]?.hidden !== true) {
          restored[name] = { ...restored[name], [head]: stored[name][head] };
        }
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
      ...(Object.keys(prompts).length > 0 ? { prompts: prompts as Record<string, MockPrompt> } : {}),
      ...(Object.keys(resources).length > 0 ? { resources: resources as Record<string, MockResource> } : {}),
      ...(Object.keys(templates).length > 0 ? { resourceTemplates: templates as Record<string, MockResourceTemplate> } : {}),
    },
    unrestorable,
  };
}
