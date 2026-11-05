import type { MCPTasksCheckId, MCPTasksCheckResult } from "./types.js";
export const CHECK_METADATA: Record<
  MCPTasksCheckId,
  Pick<MCPTasksCheckResult, "id" | "category" | "title" | "description">
> = {
  "tasks-wire-resolvable": {
    id: "tasks-wire-resolvable",
    category: "dispatch",
    title: "Tasks Wire Resolvable",
    description:
      "The negotiated protocol version and advertised capabilities resolve to exactly one tasks wire.",
  },
  "tasks-declaration-hygiene": {
    id: "tasks-declaration-hygiene",
    category: "dispatch",
    title: "Per-Version Declaration Hygiene",
    description:
      "Outgoing requests carry `params.task` only on the legacy wire and the tasks extension declaration only on the extension wire; a connection with no tasks wire sends neither.",
  },
  "tasks-result-type-discipline": {
    id: "tasks-result-type-discipline",
    category: "creation",
    title: "Result Type Discipline",
    description:
      'A task-eligible tools/call returns either a normal tool result or a flat CreateTaskResult with resultType "task" and a server-generated taskId.',
  },
  "tasks-undeclared-creation-refused": {
    id: "tasks-undeclared-creation-refused",
    category: "creation",
    title: "Undeclared Task Creation Refused",
    description:
      "On the extension wire, a tools/call that did not carry the extension declaration must not come back as a CreateTaskResult: the server either answers normally or rejects with -32021.",
  },
  "tasks-undeclared-capability-rejected": {
    id: "tasks-undeclared-capability-rejected",
    category: "lifecycle",
    title: "Undeclared Capability Rejected",
    description:
      "tasks/get, tasks/update, tasks/cancel and a task-filtered subscriptions/listen sent WITHOUT the extension declaration must each be rejected with -32021 (Missing Required Client Capability).",
  },
  "tasks-ttl-shape": {
    id: "tasks-ttl-shape",
    category: "lifecycle",
    title: "TTL And Poll Interval Shapes",
    description:
      "Task TTL and poll interval use the era-native shapes: `ttlMs: number|null` / `pollIntervalMs` on the extension, `ttl` / `pollInterval` on the legacy wire.",
  },
  "tasks-inline-result": {
    id: "tasks-inline-result",
    category: "lifecycle",
    title: "Completed Task Carries Its Result",
    description:
      "A completed task exposes its result the era-native way: inline on the extension's tasks/get, via tasks/result on the legacy wire.",
  },
  "tasks-mcp-name-routing": {
    id: "tasks-mcp-name-routing",
    category: "lifecycle",
    title: "Mcp-Name Task Routing",
    description:
      "Over HTTP, tasks/get is sent with Mcp-Name set to the task id (captured off the fetch seam) and accepted by the server.",
  },
  "tasks-invalid-task-id-rejected": {
    id: "tasks-invalid-task-id-rejected",
    category: "lifecycle",
    title: "Invalid Task Id Rejected",
    description:
      "tasks/get for a task id the server never issued is rejected with -32602 (Invalid params); the same rejection on tasks/update and tasks/cancel is a SHOULD and is reported as advice.",
  },
  "tasks-status-payload-shape": {
    id: "tasks-status-payload-shape",
    category: "lifecycle",
    title: "Status Payload Shape",
    description:
      "Each observed task status carries the payload its status requires: `result` on completed, `error` on failed, `inputRequests` on input_required.",
  },
  "tasks-cancel-ack-shape": {
    id: "tasks-cancel-ack-shape",
    category: "lifecycle",
    title: "Cancel Acknowledged With An Empty Result",
    description:
      "tasks/cancel is acknowledged with an empty result rather than a task state, and the task's observable status is allowed to remain non-terminal afterwards.",
  },
  "tasks-update-ack-shape": {
    id: "tasks-update-ack-shape",
    category: "lifecycle",
    title: "Update Acknowledged With An Empty Result",
    description:
      'tasks/update answering a task\'s input_required is acknowledged with an empty result carrying resultType "complete"; the task is not required to reach a terminal status afterwards.',
  },
  "tasks-ttl-integer-shape": {
    id: "tasks-ttl-integer-shape",
    category: "lifecycle",
    title: "TTL And Poll Interval Are Integers",
    description:
      "ttlMs and pollIntervalMs are integer milliseconds, as the extension's Task interface states.",
  },
  "tasks-undeclared-capability-names-requirements": {
    id: "tasks-undeclared-capability-names-requirements",
    category: "lifecycle",
    title: "Undeclared Capability Error Names What Is Missing",
    description:
      "A -32021 rejection carries error.data.requiredCapabilities naming the capability the client failed to declare.",
  },
};
