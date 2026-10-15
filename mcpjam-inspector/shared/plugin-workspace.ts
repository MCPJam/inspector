/** A presentation namespace, never an actor, target, grant or instance proof. */
export interface PluginWorkspaceDescriptor {
  version: 1;
  workspaceId: string;
}

export class PluginWorkspaceRequestError extends Error {
  constructor() {
    super("Malformed plugin workspace descriptor");
    this.name = "PluginWorkspaceRequestError";
  }
}

/** Absence preserves the legacy chat path. Present invalid values fail closed. */
export function parsePluginWorkspaceDescriptor(
  value: unknown,
): PluginWorkspaceDescriptor | undefined {
  if (value === undefined) return undefined;
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).length !== 2 ||
    !Object.hasOwn(value, "version") ||
    !Object.hasOwn(value, "workspaceId")
  ) {
    throw new PluginWorkspaceRequestError();
  }
  const descriptor = value as Record<string, unknown>;
  if (
    descriptor.version !== 1 ||
    typeof descriptor.workspaceId !== "string" ||
    !descriptor.workspaceId.trim() ||
    new TextEncoder().encode(descriptor.workspaceId).byteLength > 4096 ||
    /[\u0000-\u001f\u007f]/.test(descriptor.workspaceId)
  ) {
    throw new PluginWorkspaceRequestError();
  }
  return { version: 1, workspaceId: descriptor.workspaceId };
}
