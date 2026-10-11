export interface PluginInstanceIdentity {
  workspaceId: string;
  scope: { kind: "global" } | { kind: "thread"; threadId: string };
  pluginVersionId: string;
  serverId: string;
  bindingId: string;
  origin: {
    kind: "global" | "thread" | "settings" | "file" | "quick-action" | "tool";
    id: string;
  };
  resourceUri?: string;
}

/** Positional JSON avoids delimiter collisions and includes every authority boundary. */
export function pluginInstanceKey(identity: PluginInstanceIdentity): string {
  const parts = [
    identity.workspaceId,
    identity.scope.kind,
    identity.scope.kind === "thread" ? identity.scope.threadId : "",
    identity.pluginVersionId,
    identity.serverId,
    identity.bindingId,
    identity.origin.kind,
    identity.origin.id,
    identity.resourceUri ?? "",
  ];
  if (
    parts.some(
      (part, index) =>
        (index !== 2 && index !== 8 && !part) || part.length > 4096
    )
  )
    throw new Error("Invalid plugin instance identity");
  if (identity.scope.kind === "thread" && !identity.scope.threadId)
    throw new Error("Missing thread identity");
  if (identity.origin.kind === "file" && !identity.resourceUri)
    throw new Error("Missing file resource identity");
  return JSON.stringify(parts);
}
