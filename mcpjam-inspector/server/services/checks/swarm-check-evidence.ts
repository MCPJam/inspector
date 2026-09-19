import { toTranscriptToolInventory } from "../evals/transcript-evidence.js";
const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);
/** Only the frozen archive confers declaration evidence. Ambiguous names and
 * changed catalogs cannot be merged into a made-up runtime inventory. */
export function swarmCheckInventory(envelope: unknown) {
  if (!record(envelope) || !record(envelope.recordedContext)) return undefined;
  const snapshots = envelope.recordedContext.toolSnapshots;
  if (!Array.isArray(snapshots) || snapshots.length !== 1) return undefined;
  const entry = snapshots[0];
  if (
    !record(entry) ||
    !record(entry.snapshot) ||
    !Array.isArray(entry.snapshot.servers)
  )
    return undefined;
  const tools: Record<
    string,
    {
      inputSchema?: unknown;
      description?: string;
      annotations?: Record<string, unknown>;
    }
  > = {};
  for (const server of entry.snapshot.servers) {
    if (!record(server) || server.captureError || !Array.isArray(server.tools))
      return undefined;
    for (const tool of server.tools) {
      if (
        !record(tool) ||
        typeof tool.name !== "string" ||
        Object.hasOwn(tools, tool.name)
      )
        return undefined;
      tools[tool.name] = {
        inputSchema: tool.inputSchema,
        ...(typeof tool.description === "string"
          ? { description: tool.description }
          : {}),
        ...(record(tool.annotations) ? { annotations: tool.annotations } : {}),
      };
    }
  }
  return toTranscriptToolInventory(tools);
}
