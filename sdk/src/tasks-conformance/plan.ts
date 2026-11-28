import {
  MCP_TASKS_CHECK_IDS,
  isTasksToolCheck,
  taskCheckUsesInput,
  type MCPTasksCheckOverrides,
  type MCPTasksCheckId,
  type MCPTasksRunOptions,
} from "./types.js";

export function validateTaskOverrides(value: unknown): MCPTasksCheckOverrides {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("checkOverrides must be an object");
  const result: MCPTasksCheckOverrides = {};
  for (const [id, setup] of Object.entries(value)) {
    if (!isTasksToolCheck(id))
      throw new Error(`Check ${id} does not accept a tool override`);
    if (!setup || typeof setup !== "object" || Array.isArray(setup))
      throw new Error(`Invalid tool override for ${id}`);
    if (
      Object.keys(setup).some(
        (key) =>
          key !== "toolName" &&
          key !== "toolArguments" &&
          !(key === "inputResponses" && taskCheckUsesInput(id))
      )
    )
      throw new Error(`Unknown tool override field for ${id}`);
    const { toolName, toolArguments, inputResponses } = setup;
    if (
      inputResponses !== undefined &&
      (!inputResponses ||
        typeof inputResponses !== "object" ||
        Array.isArray(inputResponses) ||
        JSON.stringify(inputResponses).length > 10_000)
    )
      throw new Error(`Invalid input responses for ${id}`);
    if (typeof toolName !== "string" || !toolName.trim())
      throw new Error(`A tool name is required for ${id}`);
    if (toolName.trim().length > 256)
      throw new Error(
        `The tool name for ${id} must be 256 characters or fewer`
      );
    if (
      toolArguments !== undefined &&
      (!toolArguments ||
        typeof toolArguments !== "object" ||
        Array.isArray(toolArguments))
    )
      throw new Error(`Tool arguments for ${id} must be an object`);
    if (
      toolArguments !== undefined &&
      JSON.stringify(toolArguments).length > 10_000
    )
      throw new Error(
        `Tool arguments for ${id} must be under 10,000 characters`
      );
    result[id] = {
      toolName: toolName.trim(),
      ...(inputResponses ? { inputResponses } : {}),
      ...(toolArguments === undefined ? {} : { toolArguments }),
    };
  }
  return result;
}

/** Object key order is irrelevant; array order and primitive types are not. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object")
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, val]) => `${JSON.stringify(key)}:${canonical(val)}`)
      .join(",")}}`;
  return JSON.stringify(value) ?? "null";
}
function kind(id: MCPTasksCheckId): string {
  if (!isTasksToolCheck(id)) return "discovery";
  if (id === "tasks-undeclared-creation-refused") return "undeclared-creation";
  if (id === "tasks-update-ack-shape") return "update";
  if (id === "tasks-cancel-ack-shape") return "cancel";
  if (
    id === "tasks-undeclared-capability-rejected" ||
    id === "tasks-undeclared-capability-names-requirements"
  )
    return "undeclared-methods";
  return "observation";
}
export interface MCPTasksRunGroup extends MCPTasksRunOptions {
  checkIds: MCPTasksCheckId[];
}

/** This plan is also used by Inspector to give each group its own HTTP budget. */
export function planTasksConformance(
  options: MCPTasksRunOptions
): MCPTasksRunGroup[] {
  const overrides = validateTaskOverrides(options.checkOverrides ?? {});
  const selected = new Set(options.checkIds ?? MCP_TASKS_CHECK_IDS);
  const groups = new Map<string, MCPTasksRunGroup>();
  for (const id of selected) {
    if (!MCP_TASKS_CHECK_IDS.includes(id))
      throw new Error(`Unknown MCP Tasks check: ${id}`);
    const setup = isTasksToolCheck(id)
      ? (overrides[id] ?? {
          toolName: options.toolName,
          inputResponses: options.inputResponses,
          toolArguments: options.toolArguments,
        })
      : {};
    const flow = kind(id);
    const answers =
      (flow === "observation" || flow === "update") &&
      setup.inputResponses &&
      Object.keys(setup.inputResponses).length > 0
        ? setup.inputResponses
        : undefined;
    const subject =
      id === "tasks-update-ack-shape" && !answers ? "observation" : flow;
    const key = canonical([
      subject,
      setup.toolName ?? null,
      setup.toolArguments ?? {},
      answers ?? null,
    ]);
    const existing = groups.get(key);
    const group: MCPTasksRunGroup = existing ?? {
      checkIds: [],
      ...(options.protocolVersion
        ? { protocolVersion: options.protocolVersion }
        : {}),
      readinessIds: options.readinessIds,
      ...(setup.toolName ? { toolName: setup.toolName } : {}),
      ...(setup.toolArguments ? { toolArguments: setup.toolArguments } : {}),
    };
    group.checkIds.push(id);
    // Passive checks can observe the same task without creating an extra one.
    if (answers && taskCheckUsesInput(id)) group.inputResponses = answers;
    groups.set(key, group);
  }
  return [...groups.values()];
}
