/**
 * Family 20: Tasks. The 2025-11-25 core utility (`capabilities.tasks`,
 * `execution.taskSupport`, `tasks/list|get|result|cancel`) and the
 * `io.modelcontextprotocol/tasks` extension (`tasks/get|update|cancel`) are
 * different wire protocols. Each rule answers only for the form the captured
 * revision negotiates, following `resolveTasksWire`, so a server that
 * supports both revisions is never read as contradicting itself.
 */

import { MCP_TASKS_EXTENSION_ID } from "../../../mcp-client-manager/tasks-dispatch.js";
import { protocolEra } from "../../context.js";
import type {
  DeclaredSurface,
  FeatureDefinition,
  FeatureRuleOutcome,
} from "../../types.js";
import { coreSpec } from "../spec-refs.js";
import {
  capabilitiesOf,
  countOf,
  extensionOutcome,
  familyFeature,
  isComplete,
  recordAt,
  specAt,
  stringAt,
  unlessParentAbsent,
  type WireRecord,
} from "./shared.js";

type TasksForm = "core" | "extension" | "none" | "unknown";

/** The Tasks form a captured revision speaks, as `resolveTasksWire` routes it. */
export function tasksFormFor(protocolVersion: string | undefined): TasksForm {
  const era = protocolEra(protocolVersion);
  if (era === "modern") return "extension";
  if (era === "legacy")
    return protocolVersion === "2025-11-25" ? "core" : "none";
  return "unknown";
}

const UNKNOWN_FORM: FeatureRuleOutcome = {
  kind: "unknown",
  reason:
    "The protocol version of this capture is unknown, so the Tasks form cannot be chosen.",
};

/** Runs `rule` only when the capture speaks `form`; other forms have no claim. */
function forForm(
  form: Exclude<TasksForm, "none" | "unknown">,
  rule: (surface: DeclaredSurface) => FeatureRuleOutcome
) {
  return (surface: DeclaredSurface): FeatureRuleOutcome => {
    const actual = tasksFormFor(surface.protocolVersion);
    if (actual === "unknown") return UNKNOWN_FORM;
    return actual === form ? rule(surface) : null;
  };
}

/** `capabilities.tasks`, or the pre-standard `capabilities.experimental.tasks`. */
function coreTasksCapability(surface: DeclaredSurface): WireRecord | undefined {
  const capabilities = capabilitiesOf(surface);
  return (
    recordAt(capabilities, "tasks") ??
    recordAt(recordAt(capabilities, "experimental"), "tasks")
  );
}

function coreCapabilityOutcome(surface: DeclaredSurface): FeatureRuleOutcome {
  const tasks = coreTasksCapability(surface);
  if (!tasks) return { kind: "absent", basis: ["capabilities"] };
  const parts = [
    tasks.list !== undefined ? "list" : undefined,
    tasks.cancel !== undefined ? "cancel" : undefined,
    recordAt(recordAt(tasks, "requests"), "tools")?.call !== undefined
      ? "requests.tools.call"
      : undefined,
  ].filter((part): part is string => part !== undefined);
  return {
    kind: "present",
    via: "advertised",
    detail: parts.length > 0 ? parts.join(", ") : "empty tasks capability",
  };
}

const NO_CORE_TASKS = "The server does not declare the Tasks capability.";
const NO_TASKS_EXTENSION = "The server does not declare the Tasks extension.";

/** A sub-capability flag of the core utility, by presence. */
function coreFlag(read: (tasks: WireRecord) => unknown) {
  return forForm("core", (surface) => {
    const tasks = coreTasksCapability(surface);
    if (!tasks)
      return unlessParentAbsent(
        surface,
        coreCapabilityOutcome(surface),
        NO_CORE_TASKS
      );
    return read(tasks) !== undefined
      ? { kind: "present", via: "advertised" }
      : { kind: "absent", basis: ["capabilities"] };
  });
}

const coreDependent = forForm("core", (surface) =>
  unlessParentAbsent(surface, coreCapabilityOutcome(surface), NO_CORE_TASKS)
);

function extensionDeclaration(surface: DeclaredSurface): FeatureRuleOutcome {
  return extensionOutcome(
    surface,
    MCP_TASKS_EXTENSION_ID,
    "The Tasks extension"
  );
}

const extensionDependent = forForm("extension", (surface) =>
  unlessParentAbsent(surface, extensionDeclaration(surface), NO_TASKS_EXTENSION)
);

const TASK_SUPPORT_VALUES = new Set(["optional", "required"]);

const coreFeature = familyFeature("tasks", "experimental");
const extFeature = familyFeature("tasks", "beta");
const CORE_LIFECYCLE = { introduced: "2025-11-25", removed: "2026-07-28" };
const EXT_LIFECYCLE = { introduced: "2026-07-28" };
const coreTasksSpec = (anchor?: string) =>
  coreSpec("2025-11-25", "basic/utilities/tasks", anchor);
const CALL_A_TASK_TOOL =
  "Call a tool that runs as a task in the Playground, then watch Tracing.";

function coreObserved(
  input: Pick<FeatureDefinition, "id" | "name" | "summary" | "howTo" | "spec">
): FeatureDefinition {
  return coreFeature({
    parent: "tasks.core",
    lifecycle: CORE_LIFECYCLE,
    ...input,
    assessment: {
      primary: "observed",
      observable: true,
      declared: coreDependent,
    },
  });
}

function extObserved(
  input: Pick<FeatureDefinition, "id" | "name" | "summary" | "howTo" | "spec"> &
    Partial<Pick<FeatureDefinition, "owner">>
): FeatureDefinition {
  return extFeature({
    parent: "tasks.ext",
    lifecycle: EXT_LIFECYCLE,
    ...input,
    assessment: {
      primary: "observed",
      observable: true,
      declared: extensionDependent,
    },
  });
}

export const TASKS_FEATURES: readonly FeatureDefinition[] = [
  coreFeature({
    id: "tasks.core",
    name: "Tasks utility (2025-11-25)",
    summary:
      "The experimental core Tasks utility that 2025-11-25 servers use for long-running calls.",
    howTo:
      "Declare capabilities.tasks and set execution.taskSupport on tools that can run as tasks.",
    lifecycle: CORE_LIFECYCLE,
    spec: coreTasksSpec(),
    assessment: {
      primary: "declared",
      declared: forForm("core", coreCapabilityOutcome),
    },
  }),
  coreFeature({
    id: "tasks.core.capability",
    parent: "tasks.core",
    name: "tasks capability (list, cancel, requests.tools.call)",
    summary:
      "Tells clients which task operations and task-augmented requests the server accepts.",
    howTo:
      "Declare capabilities.tasks with list, cancel and requests.tools.call for the operations you support.",
    lifecycle: CORE_LIFECYCLE,
    spec: coreTasksSpec("server-capabilities"),
    assessment: {
      primary: "declared",
      declared: forForm("core", coreCapabilityOutcome),
    },
  }),
  coreFeature({
    id: "tasks.core.tool-task-support",
    parent: "tasks.core",
    name: "execution.taskSupport",
    summary:
      "Marks each tool as forbidden, optional or required to run as a task.",
    howTo:
      'Set execution.taskSupport to "optional" or "required" on tools that can run as tasks. "forbidden" is the default.',
    lifecycle: CORE_LIFECYCLE,
    spec: coreTasksSpec("tool-level-negotiation"),
    assessment: {
      primary: "declared",
      declared: forForm("core", (surface) => {
        if (surface.tools.length === 0 && isComplete(surface, ["tools"])) {
          return {
            kind: "not-applicable",
            reason: "This server lists no tools.",
          };
        }
        const count = surface.tools.filter((tool) => {
          const support = stringAt(recordAt(tool, "execution"), "taskSupport");
          return support !== undefined && TASK_SUPPORT_VALUES.has(support);
        }).length;
        if (count > 0) {
          return {
            kind: "present",
            via: "detected",
            count,
            detail: countOf(count, surface.tools.length, "tools"),
          };
        }
        return { kind: "absent", basis: ["tools"] };
      }),
    },
  }),
  coreObserved({
    id: "tasks.core.augmented-call",
    name: "Task-augmented tools/call",
    summary:
      "A tools/call with params.task returns a CreateTaskResult instead of waiting.",
    howTo: CALL_A_TASK_TOOL,
    spec: coreTasksSpec("creating-tasks"),
  }),
  coreObserved({
    id: "tasks.core.get",
    name: "tasks/get",
    summary: "Returns a task's current status.",
    howTo: CALL_A_TASK_TOOL,
    spec: coreTasksSpec("getting-tasks"),
  }),
  coreObserved({
    id: "tasks.core.result",
    name: "tasks/result",
    summary: "Waits for a task to finish and returns its result.",
    howTo: CALL_A_TASK_TOOL,
    spec: coreTasksSpec("retrieving-task-results"),
  }),
  coreFeature({
    id: "tasks.core.list",
    parent: "tasks.core",
    name: "tasks/list",
    summary: "Lists the tasks the server is tracking for this client.",
    howTo: "Declare capabilities.tasks.list and answer tasks/list.",
    lifecycle: CORE_LIFECYCLE,
    spec: coreTasksSpec("listing-tasks"),
    assessment: {
      primary: "declared",
      declared: coreFlag((tasks) => tasks.list),
      observable: true,
    },
  }),
  coreFeature({
    id: "tasks.core.cancel",
    parent: "tasks.core",
    name: "tasks/cancel",
    summary: "Stops a running task.",
    howTo: "Declare capabilities.tasks.cancel and answer tasks/cancel.",
    lifecycle: CORE_LIFECYCLE,
    spec: coreTasksSpec("cancelling-tasks"),
    assessment: {
      primary: "observed",
      declared: coreFlag((tasks) => tasks.cancel),
      observable: true,
    },
  }),
  coreObserved({
    id: "tasks.core.status-notification",
    name: "notifications/tasks/status",
    summary:
      "The server pushes task status changes instead of waiting to be polled.",
    howTo: CALL_A_TASK_TOOL,
    spec: coreTasksSpec("task-status-notification"),
  }),
  coreObserved({
    id: "tasks.core.input-required",
    name: "input_required status with related-task _meta",
    summary:
      "A task pauses to ask the client for input, tagged with the task it belongs to.",
    howTo: `${CALL_A_TASK_TOOL} Use a tool that asks for input while it runs.`,
    spec: coreTasksSpec("input-required-status"),
  }),
  extFeature({
    id: "tasks.ext",
    name: "Tasks extension",
    summary:
      "The io.modelcontextprotocol/tasks extension for long-running tool calls on 2026-07-28.",
    howTo:
      'Declare extensions["io.modelcontextprotocol/tasks"] = {} and return tasks from slow tool calls.',
    lifecycle: EXT_LIFECYCLE,
    spec: specAt("tasks"),
    assessment: {
      primary: "declared",
      declared: forForm("extension", extensionDeclaration),
    },
  }),
  extFeature({
    id: "tasks.ext.declaration",
    parent: "tasks.ext",
    name: "io.modelcontextprotocol/tasks declaration",
    summary:
      "Tells clients the server may answer tools/call with a task. It does not say which tools do.",
    howTo:
      'Declare extensions["io.modelcontextprotocol/tasks"] = {}. Which tools return tasks shows only when they run.',
    lifecycle: EXT_LIFECYCLE,
    spec: specAt("tasks", "capability-negotiation"),
    assessment: {
      primary: "declared",
      declared: forForm("extension", extensionDeclaration),
    },
  }),
  extObserved({
    id: "tasks.ext.create-task-result",
    name: 'CreateTaskResult (resultType "task")',
    summary: "The server answers a tools/call with a task the client can poll.",
    howTo: `${CALL_A_TASK_TOOL} An ordinary result does not mean tasks are unsupported.`,
    spec: specAt("tasks", "polymorphic-results"),
  }),
  extObserved({
    id: "tasks.ext.polling",
    name: "tasks/get polling (pollIntervalMs, ttlMs)",
    summary:
      "The client polls the task at the interval the server suggests until it finishes.",
    howTo: CALL_A_TASK_TOOL,
    spec: specAt("tasks", "task-polling"),
  }),
  extObserved({
    id: "tasks.ext.update",
    name: "tasks/update (inputResponses)",
    summary:
      "The client answers a task's input requests without restarting the call.",
    howTo: `${CALL_A_TASK_TOOL} Use a tool that asks for input while it runs.`,
    spec: specAt("tasks", "task-update-requests"),
  }),
  extObserved({
    id: "tasks.ext.cancel",
    name: "tasks/cancel",
    summary: "The client asks the server to stop a task.",
    howTo: `${CALL_A_TASK_TOOL} Cancel the task while it runs.`,
    spec: specAt("tasks", "task-cancellation"),
  }),
  extObserved({
    id: "tasks.ext.notifications",
    name: "notifications/tasks on subscriptions/listen",
    summary:
      "The server pushes task status to clients that subscribe by task id.",
    howTo: CALL_A_TASK_TOOL,
    spec: specAt("tasks", "task-status-notifications"),
  }),
  extObserved({
    id: "tasks.ext.missing-capability-error",
    name: "-32021 when the client did not declare the extension",
    summary:
      "The server rejects task requests from clients that did not declare the Tasks extension.",
    howTo:
      "Run checks to send task requests without the extension declaration.",
    spec: specAt("tasks", "capability-negotiation"),
  }),
  extFeature({
    id: "tasks.ext.mcp-name-routing",
    parent: "tasks.ext",
    name: "Mcp-Name carries the task id",
    summary:
      "Over HTTP, task requests name the task in the Mcp-Name header so gateways can route them.",
    howTo:
      "Run checks. The Tasks suite sends tasks/get with Mcp-Name set to the task id.",
    owner: "client",
    lifecycle: EXT_LIFECYCLE,
    spec: specAt("tasks", "streamable-http-routing-headers"),
    assessment: { primary: "checked", declared: extensionDependent },
  }),
  extFeature({
    id: "tasks.ext.unknown-task-id",
    parent: "tasks.ext",
    name: "Unknown task id rejected with -32602",
    summary:
      "tasks/get for a task id the server never issued fails with Invalid params.",
    howTo:
      "Run checks. The Tasks suite asks for a task id the server never issued.",
    lifecycle: EXT_LIFECYCLE,
    spec: specAt("tasks", "protocol-errors"),
    assessment: { primary: "checked", declared: extensionDependent },
  }),
];
