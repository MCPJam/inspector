/** The preview deliberately checks the full launch contract, not only models.
 * Local readiness is an early hint; this catches stale plugins, servers and
 * configs before generation or goal writes. The launch gate remains final.
 */
export function missingSwarmModelMessage(clientName: string): string {
  return `${clientName} has no model. Pick a model in Models and deselect Client defaults, or set a model on the client.`;
}

export class SwarmTargetPreflightError extends Error {
  constructor(
    message: string,
    readonly code?: string,
    readonly hostId?: string,
  ) {
    super(message);
    this.name = "SwarmTargetPreflightError";
  }
}

export async function preflightSwarmTargets(args: {
  environmentIds: string[];
  resolve: (environmentId: string) => Promise<unknown>;
  targets: Array<{ environmentId: string; hostId: string; name?: string }>;
  hosts: Array<{ hostId: string; name: string }>;
}): Promise<void> {
  for (const environmentId of args.environmentIds) {
    try {
      await args.resolve(environmentId);
    } catch (error) {
      const target = args.targets.find(
        (row) => row.environmentId === environmentId,
      );
      let data = (error as { data?: unknown } | null)?.data;
      // ConvexError data may arrive encoded across older HTTP bridges.
      if (typeof data === "string") {
        try {
          data = JSON.parse(data);
        } catch {
          data = undefined;
        }
      }
      const record =
        data && typeof data === "object"
          ? (data as Record<string, unknown>)
          : {};
      const code = typeof record.code === "string" ? record.code : undefined;
      const details =
        record.details && typeof record.details === "object"
          ? (record.details as Record<string, unknown>)
          : {};
      const hostId =
        typeof details.hostId === "string" ? details.hostId : target?.hostId;
      const host = args.hosts.find((row) => row.hostId === hostId);
      if (code === "ENV_MODEL_REQUIRED") {
        throw new SwarmTargetPreflightError(
          missingSwarmModelMessage(host?.name ?? target?.name ?? "This client"),
          code,
          hostId,
        );
      }
      const reason =
        typeof record.message === "string"
          ? record.message
          : error instanceof Error
          ? error.message
          : "Could not verify this target. Try again.";
      throw new SwarmTargetPreflightError(
        `${target?.name ?? host?.name ?? "Selected target"}: ${reason}`,
        code,
      );
    }
  }
}
