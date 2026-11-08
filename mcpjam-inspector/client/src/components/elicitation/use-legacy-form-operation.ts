import { useEffect, useState } from "react";
import type { HostedElicitationRequestEvent } from "@/shared/hosted-elicitation";
import type { PluginFormOperation } from "@/shared/plugin-form-services";
import { checkPluginFormDestination } from "./form-files";

/** Resolve only the authenticated source's identity; never derive it from form fields. */
export function useLegacyFormOperation(
  projectId: string,
  workspaceId: string,
  request: HostedElicitationRequestEvent,
) {
  const { rendezvousId, pluginFormSourceToken, serverId, expiresAt } = request;
  const key = JSON.stringify([
    projectId,
    workspaceId,
    rendezvousId,
    pluginFormSourceToken,
    serverId,
    expiresAt,
  ]);
  const [resolved, setResolved] = useState<{
    key: string;
    operation: PluginFormOperation;
  }>();
  useEffect(() => {
    if (!pluginFormSourceToken || expiresAt <= Date.now()) return;
    const controller = new AbortController();
    const expiry = setTimeout(() => {
      controller.abort();
      setResolved(undefined);
    }, expiresAt - Date.now());
    void checkPluginFormDestination({
      scope: { projectId, workspaceId },
      sourceToken: pluginFormSourceToken,
      parent: { kind: "legacy", id: rendezvousId, round: 0 },
      expiresAt,
      signal: controller.signal,
      includeOperation: true,
    })
      .then(({ operation }) => {
        if (
          !controller.signal.aborted &&
          operation?.projectId === projectId &&
          operation.workspaceId === workspaceId &&
          operation.serverId === serverId &&
          operation.expiresAt <= expiresAt &&
          operation.expiresAt > Date.now()
        )
          setResolved({ key, operation });
      })
      .catch(() => {
        // The shared service reader reports failures; a missing identity cannot extend a call.
      });
    return () => {
      controller.abort();
      clearTimeout(expiry);
    };
  }, [
    key,
    projectId,
    workspaceId,
    rendezvousId,
    pluginFormSourceToken,
    serverId,
    expiresAt,
  ]);
  return resolved?.key === key ? resolved.operation : undefined;
}
