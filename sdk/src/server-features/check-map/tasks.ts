import type { TasksCheckFeatureMap } from "./types.js";

/**
 * Tasks suite check → catalog features (family 20). Checks that run on both
 * wires map to the core and the extension feature; a result only counts for
 * the revision its run negotiated, and lifecycle hides the other form.
 */
export const TASKS_CHECK_FEATURES = {
  "tasks-result-type-discipline": [
    "tasks.core.augmented-call",
    "tasks.ext.create-task-result",
  ],
  "tasks-undeclared-creation-refused": ["tasks.ext.create-task-result"],
  "tasks-undeclared-capability-rejected": [
    "tasks.ext.missing-capability-error",
  ],
  "tasks-ttl-shape": ["tasks.core.get", "tasks.ext.polling"],
  "tasks-inline-result": ["tasks.core.result", "tasks.ext.polling"],
  "tasks-mcp-name-routing": ["tasks.ext.mcp-name-routing"],
  "tasks-invalid-task-id-rejected": ["tasks.ext.unknown-task-id"],
  "tasks-status-payload-shape": ["tasks.core.get", "tasks.ext.polling"],
  "tasks-cancel-ack-shape": ["tasks.ext.cancel"],
  "tasks-update-ack-shape": ["tasks.ext.update"],
  "tasks-ttl-integer-shape": ["tasks.ext.polling"],
  "tasks-undeclared-capability-names-requirements": [
    "tasks.ext.missing-capability-error",
  ],
} as const satisfies TasksCheckFeatureMap;
