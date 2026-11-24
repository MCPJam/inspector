/**
 * Families 5 and 6: Tools, and tool annotations and schemas. Descriptor rules
 * read tools by their MCP wire names.
 */

import type { DeclaredItem, FeatureDefinition } from "../../types.js";
import { coreSpec } from "../spec-refs.js";
import {
  absent,
  annotation,
  collectJsonStrings,
  countItems,
  declaresCapability,
  hasKeys,
  isComplete,
  isNonEmptyString,
  isRecord,
  lifecycle,
  listsItems,
  emptyList,
  notApplicable,
  notApplicableWhenComplete,
  present,
  promisedFlag,
  toolSchemas,
  unknown,
  type DeclaredRule,
} from "./rules.js";

const TOOLS = "server/tools";
const MODERN = lifecycle({ introduced: "2026-07-28" });

/** SEP-986 tool name guidance. */
const TOOL_NAME = /^[A-Za-z0-9_.-]{1,128}$/;

const toolNames: DeclaredRule = (surface) => {
  const outcome = countItems("tools", (tool) => isNonEmptyString(tool.name), [
    "tools",
  ])(surface);
  if (outcome?.kind !== "present") return outcome;
  const outside = surface.tools.filter(
    (tool) => typeof tool.name === "string" && !TOOL_NAME.test(tool.name)
  ).length;
  return outside > 0
    ? {
        ...outcome,
        detail: `${outside} of ${surface.tools.length} names fall outside the naming guidance.`,
      }
    : outcome;
};

/** A hint counts when set either way: explicit false is a declaration too. */
function hintRule(hint: string): DeclaredRule {
  return (surface) => {
    const outcome = countItems(
      "tools",
      (tool) => typeof annotation(tool, hint) === "boolean",
      ["tools"]
    )(surface);
    if (outcome?.kind !== "present" || outcome.count === undefined) {
      return outcome;
    }
    const setTrue = surface.tools.filter(
      (tool) => annotation(tool, hint) === true
    ).length;
    return {
      ...outcome,
      detail: `Set on ${outcome.count} of ${surface.tools.length} tools: ${setTrue} true, ${outcome.count - setTrue} false.`,
    };
  };
}

function taskSupport(tool: DeclaredItem): unknown {
  return isRecord(tool.execution) ? tool.execution.taskSupport : undefined;
}

const taskSupportRule: DeclaredRule = (surface) => {
  const outcome = countItems(
    "tools",
    (tool) =>
      taskSupport(tool) === "optional" || taskSupport(tool) === "required",
    ["tools"]
  )(surface);
  if (outcome?.kind !== "absent") return outcome;
  const forbidden = surface.tools.some(
    (tool) => taskSupport(tool) === "forbidden"
  );
  return forbidden
    ? absent(
        outcome.basis,
        "Every tool that sets taskSupport sets it to forbidden."
      )
    : outcome;
};

const schemaDialectRule: DeclaredRule = (surface) => {
  const outcome = countItems(
    "tools",
    (tool) =>
      toolSchemas(tool).some(
        (schema) => isRecord(schema) && isNonEmptyString(schema.$schema)
      ),
    ["tools", "toolSchemas"]
  )(surface);
  if (outcome?.kind !== "absent") return outcome;
  return notApplicableWhenComplete(
    surface,
    ["tools", "toolSchemas"],
    "Every tool schema uses the default dialect, JSON Schema 2020-12."
  );
};

const refBoundsRule: DeclaredRule = (surface) => {
  if (surface.tools.length === 0) return emptyList(surface, "tools");
  // Storage strips $-prefixed keys unless it kept the full schema JSON.
  if (!isComplete(surface, ["toolSchemas"])) {
    return unknown(
      "The saved tool schemas may have lost their $ref keys. Reconnect to capture them in full."
    );
  }
  const refs = surface.tools.flatMap((tool) =>
    toolSchemas(tool).flatMap((schema) => collectJsonStrings(schema, "$ref"))
  );
  if (refs.length === 0) return notApplicable("No tool schema uses $ref.");
  const external = refs.filter((ref) => !ref.startsWith("#")).length;
  return external === 0
    ? present("detected", {
        count: refs.length,
        detail: "Every $ref is local.",
      })
    : unknown(`${external} $ref pointers lead outside the schema.`);
};

export const TOOLS_DISCOVERY_FEATURES: readonly FeatureDefinition[] = [
  {
    id: "tools.capability",
    family: "tools-discovery",
    name: "tools capability",
    summary: "Declares that the server offers tools the model can call.",
    howTo:
      "Register at least one tool. MCP SDKs declare the tools capability for you.",
    owner: "server",
    spec: coreSpec("2026-07-28", TOOLS, "capabilities"),
    stage: "stable",
    lifecycle: {},
    optional: true,
    assessment: { primary: "declared", declared: declaresCapability("tools") },
  },
  {
    id: "tools.list",
    family: "tools-discovery",
    parent: "tools.capability",
    name: "tools/list",
    summary: "Returns every tool with its name, description and input schema.",
    howTo:
      "Register tools with your SDK and it answers tools/list. Page long lists with cursors.",
    owner: "server",
    spec: coreSpec("2026-07-28", TOOLS, "listing-tools"),
    stage: "stable",
    lifecycle: {},
    optional: true,
    assessment: { primary: "declared", declared: listsItems("tools", "tools") },
  },
  {
    id: "tools.name",
    family: "tools-discovery",
    parent: "tools.capability",
    name: "Tool name",
    summary:
      "A unique name the model calls the tool by: 1 to 128 letters, digits, underscores, hyphens or dots.",
    howTo:
      "Give each tool a short unique name that uses only letters, digits, _, - and dots.",
    owner: "server",
    spec: coreSpec("2026-07-28", TOOLS, "tool-names"),
    stage: "stable",
    lifecycle: {},
    optional: false,
    assessment: { primary: "declared", declared: toolNames },
  },
  {
    id: "tools.title",
    family: "tools-discovery",
    parent: "tools.capability",
    name: "Tool title",
    summary:
      "A display name clients show instead of the tool's programmatic name.",
    howTo:
      "Set title on each tool, for example Search issues for search_issues.",
    owner: "server",
    spec: coreSpec("2026-07-28", TOOLS, "tool"),
    stage: "stable",
    lifecycle: lifecycle({ introduced: "2025-06-18" }),
    optional: true,
    assessment: {
      primary: "declared",
      declared: countItems(
        "tools",
        (tool) => isNonEmptyString(tool.title),
        ["tools"],
        {
          droppedByOldSnapshots: true,
        }
      ),
    },
  },
  {
    id: "tools.description",
    family: "tools-discovery",
    parent: "tools.capability",
    name: "Tool description",
    summary: "Tells the model what the tool does and when to call it.",
    howTo:
      "Write a description for each tool that says what it does, what it returns and when to use it.",
    owner: "server",
    spec: coreSpec("2026-07-28", TOOLS, "tool"),
    stage: "stable",
    lifecycle: {},
    optional: true,
    assessment: {
      primary: "declared",
      declared: countItems(
        "tools",
        (tool) => isNonEmptyString(tool.description),
        ["tools"]
      ),
    },
  },
  {
    id: "tools.icons",
    family: "tools-discovery",
    parent: "tools.capability",
    name: "Tool icons",
    summary: "Icons clients show next to each tool.",
    howTo: "Add icons with src, mimeType and sizes to each tool.",
    owner: "server",
    spec: coreSpec("2026-07-28", TOOLS, "tool"),
    stage: "stable",
    lifecycle: lifecycle({ introduced: "2025-11-25" }),
    optional: true,
    assessment: {
      primary: "declared",
      declared: countItems(
        "tools",
        (tool) => Array.isArray(tool.icons) && tool.icons.length > 0,
        ["tools"],
        { droppedByOldSnapshots: true }
      ),
    },
  },
  {
    id: "tools.meta",
    family: "tools-discovery",
    parent: "tools.capability",
    name: "Tool _meta",
    summary: "Extension metadata on a tool, such as the MCP Apps UI link.",
    howTo:
      "Put namespaced keys in the tool's _meta when an extension or client needs them.",
    owner: "server",
    spec: coreSpec("2026-07-28", "basic/index", "meta"),
    stage: "stable",
    lifecycle: lifecycle({ introduced: "2025-06-18" }),
    optional: true,
    assessment: {
      primary: "declared",
      declared: countItems("tools", (tool) => hasKeys(tool._meta), [
        "tools",
        "toolMeta",
      ]),
    },
  },
  {
    id: "tools.list-changed",
    family: "tools-discovery",
    parent: "tools.capability",
    name: "tools.listChanged",
    summary:
      "The server tells clients when its tool list changes so they can list again.",
    howTo:
      "Declare tools.listChanged and send notifications/tools/list_changed after you add or remove tools.",
    owner: "server",
    spec: coreSpec("2026-07-28", TOOLS, "list-changed-notification"),
    stage: "stable",
    lifecycle: {},
    optional: true,
    assessment: {
      primary: "declared",
      observable: true,
      declared: promisedFlag(
        "tools",
        "listChanged",
        "a list change notification"
      ),
    },
  },
  {
    id: "tools.deterministic-order",
    family: "tools-discovery",
    parent: "tools.capability",
    name: "Deterministic tool order",
    summary:
      "tools/list returns tools in the same order every time, which keeps model prompts cacheable.",
    howTo: "Sort your tools in a fixed order before you return them.",
    owner: "server",
    spec: coreSpec("2026-07-28", TOOLS, "capabilities"),
    stage: "stable",
    lifecycle: MODERN,
    optional: true,
    assessment: { primary: "checked" },
  },
  {
    id: "tools.stable-list",
    family: "tools-discovery",
    parent: "tools.capability",
    name: "Same tool list on every connection",
    summary:
      "The tool list does not change from one connection to the next, except by authorization.",
    howTo:
      "Return the same tools to every client that has the same credentials.",
    owner: "server",
    spec: coreSpec("2026-07-28", TOOLS, "capabilities"),
    stage: "stable",
    lifecycle: MODERN,
    optional: false,
    assessment: { primary: "checked" },
  },
];

export const TOOL_ANNOTATION_SCHEMA_FEATURES: readonly FeatureDefinition[] = [
  {
    id: "tools.annotations",
    family: "tool-annotations-schemas",
    name: "Tool annotations",
    summary:
      "Hints that describe how a tool behaves, such as whether it changes anything.",
    howTo:
      "Set annotations on each tool. Clients treat them as hints, not guarantees.",
    owner: "server",
    spec: coreSpec("2026-07-28", "schema", "toolannotations"),
    stage: "stable",
    lifecycle: lifecycle({ introduced: "2025-03-26" }),
    optional: true,
    assessment: {
      primary: "declared",
      declared: countItems("tools", (tool) => hasKeys(tool.annotations), [
        "tools",
      ]),
    },
  },
  {
    id: "tools.annotations.title",
    family: "tool-annotations-schemas",
    parent: "tools.annotations",
    name: "annotations.title",
    summary:
      "A display title inside the annotations, used when the tool has no top-level title.",
    howTo:
      "Set annotations.title, or the tool's own title field on 2025-06-18 and later.",
    owner: "server",
    spec: coreSpec("2026-07-28", "schema", "toolannotations"),
    stage: "stable",
    lifecycle: lifecycle({ introduced: "2025-03-26" }),
    optional: true,
    assessment: {
      primary: "declared",
      declared: countItems(
        "tools",
        (tool) => isNonEmptyString(annotation(tool, "title")),
        ["tools"],
        { droppedByOldSnapshots: true }
      ),
    },
  },
  {
    id: "tools.annotations.read-only-hint",
    family: "tool-annotations-schemas",
    parent: "tools.annotations",
    name: "readOnlyHint",
    summary:
      "Says the tool does not change its environment, so clients can ask for less confirmation.",
    howTo: "Set readOnlyHint to true on tools that only read data.",
    owner: "server",
    spec: coreSpec("2026-07-28", "schema", "toolannotations"),
    stage: "stable",
    lifecycle: lifecycle({ introduced: "2025-03-26" }),
    optional: true,
    assessment: { primary: "declared", declared: hintRule("readOnlyHint") },
  },
  {
    id: "tools.annotations.destructive-hint",
    family: "tool-annotations-schemas",
    parent: "tools.annotations",
    name: "destructiveHint",
    summary:
      "Says whether a tool that changes things can destroy data. Without it, clients assume it can.",
    howTo:
      "Set destructiveHint to false on tools that only add data, so clients can relax confirmations.",
    owner: "server",
    spec: coreSpec("2026-07-28", "schema", "toolannotations"),
    stage: "stable",
    lifecycle: lifecycle({ introduced: "2025-03-26" }),
    optional: true,
    assessment: { primary: "declared", declared: hintRule("destructiveHint") },
  },
  {
    id: "tools.annotations.idempotent-hint",
    family: "tool-annotations-schemas",
    parent: "tools.annotations",
    name: "idempotentHint",
    summary:
      "Says that calling the tool again with the same arguments has no further effect.",
    howTo: "Set idempotentHint to true on tools that are safe to retry.",
    owner: "server",
    spec: coreSpec("2026-07-28", "schema", "toolannotations"),
    stage: "stable",
    lifecycle: lifecycle({ introduced: "2025-03-26" }),
    optional: true,
    assessment: { primary: "declared", declared: hintRule("idempotentHint") },
  },
  {
    id: "tools.annotations.open-world-hint",
    family: "tool-annotations-schemas",
    parent: "tools.annotations",
    name: "openWorldHint",
    summary:
      "Says whether the tool reaches outside systems such as the web. Without it, clients assume it does.",
    howTo: "Set openWorldHint to false on tools that only touch your own data.",
    owner: "server",
    spec: coreSpec("2026-07-28", "schema", "toolannotations"),
    stage: "stable",
    lifecycle: lifecycle({ introduced: "2025-03-26" }),
    optional: true,
    assessment: { primary: "declared", declared: hintRule("openWorldHint") },
  },
  {
    id: "tools.input-schema",
    family: "tool-annotations-schemas",
    name: "inputSchema",
    summary: "A JSON Schema object that describes the tool's arguments.",
    howTo:
      "Give every tool an inputSchema with type object, even when it takes no arguments.",
    owner: "server",
    spec: coreSpec("2026-07-28", TOOLS, "tool"),
    stage: "stable",
    lifecycle: {},
    optional: false,
    assessment: {
      primary: "declared",
      declared: countItems("tools", (tool) => isRecord(tool.inputSchema), [
        "tools",
        "toolSchemas",
      ]),
    },
  },
  {
    id: "tools.output-schema",
    family: "tool-annotations-schemas",
    name: "outputSchema",
    summary:
      "A JSON Schema for the tool's structured result, so clients can validate and use it.",
    howTo:
      "Add an outputSchema and return matching structuredContent. On 2026-07-28 it can describe any JSON value, such as an array.",
    owner: "server",
    spec: coreSpec("2026-07-28", TOOLS, "output-schema"),
    stage: "stable",
    lifecycle: lifecycle({ introduced: "2025-06-18" }),
    optional: true,
    assessment: {
      primary: "declared",
      declared: countItems("tools", (tool) => isRecord(tool.outputSchema), [
        "tools",
        "toolSchemas",
      ]),
    },
  },
  {
    id: "tools.schema-dialect",
    family: "tool-annotations-schemas",
    name: "$schema dialect",
    summary:
      "Names the JSON Schema dialect a tool schema uses. Without it, clients assume 2020-12.",
    howTo:
      "Set $schema on a tool schema when it uses a dialect other than JSON Schema 2020-12.",
    owner: "server",
    spec: coreSpec("2026-07-28", "basic/index", "schema-dialect"),
    stage: "stable",
    lifecycle: lifecycle({ introduced: "2025-11-25" }),
    optional: true,
    assessment: { primary: "declared", declared: schemaDialectRule },
  },
  {
    id: "tools.schema-ref-bounds",
    family: "tool-annotations-schemas",
    name: "$ref resolution",
    summary:
      "Tool schemas keep $ref pointers inside the schema, so clients resolve them without fetching anything.",
    howTo:
      "Use $defs with local $ref pointers that start with #. Do not point $ref at other URLs.",
    owner: "server",
    spec: coreSpec("2026-07-28", "basic/index", "ref-resolution"),
    stage: "stable",
    lifecycle: MODERN,
    optional: true,
    assessment: { primary: "declared", declared: refBoundsRule },
  },
  {
    id: "tools.execution.task-support",
    family: "tool-annotations-schemas",
    name: "execution.taskSupport",
    summary:
      "Says whether a tool can run as a task on 2025-11-25: forbidden, optional or required.",
    howTo:
      "Set execution.taskSupport to optional or required on long-running tools and declare the tasks capability.",
    owner: "server",
    spec: coreSpec(
      "2025-11-25",
      "basic/utilities/tasks",
      "tool-level-negotiation"
    ),
    stage: "stable",
    lifecycle: lifecycle({ introduced: "2025-11-25", removed: "2026-07-28" }),
    optional: true,
    assessment: { primary: "declared", declared: taskSupportRule },
  },
  {
    id: "tools.invalid-arguments-is-error",
    family: "tool-annotations-schemas",
    name: "Invalid arguments as tool errors",
    summary:
      "A call with bad arguments returns a result with isError, so the model can fix the call and retry.",
    howTo:
      "Validate arguments in the tool and return isError: true with a message instead of a protocol error.",
    owner: "server",
    spec: coreSpec("2026-07-28", TOOLS, "error-handling"),
    stage: "stable",
    lifecycle: lifecycle({ introduced: "2025-11-25" }),
    optional: true,
    assessment: { primary: "observed" },
  },
];
