import { useEffect, useState } from "react";
import { ServerSettingsPanel } from "./ServerSettingsPanel";
import { createServerSettingsApi } from "./server-settings-api";
import type { ThreadAppScope } from "./thread-app-api";

/** Caller owns panel placement; this hook owns only settings discovery and selection. */
export function useWorkspaceSettings(
  scope: ThreadAppScope | null,
  servers: readonly { serverId: string; name: string }[],
) {
  const key = JSON.stringify([
    scope?.projectId,
    scope?.hostId,
    scope?.pluginWorkspace.workspaceId,
    servers.map((server) => server.serverId),
  ]);
  const [available, setAvailable] = useState<{
    key: string;
    ids: string[];
    errors: string[];
  }>({
    key: "",
    ids: [],
    errors: [],
  });
  const [attempt, setAttempt] = useState(0);
  const [opened, setOpened] = useState<{ key: string; ids: string[] }>({
    key: "",
    ids: [],
  });
  const [selection, setSelection] = useState<{
    key: string;
    serverId: string;
  } | null>(null);
  useEffect(() => {
    if (!scope) return;
    const abort = new AbortController();
    const errors: string[] = [];
    void Promise.all(
      servers.map(async (server) => {
        try {
          return (await createServerSettingsApi(
            scope,
            server.serverId,
            async () => false,
          ).discover(abort.signal))
            ? server.serverId
            : null;
        } catch {
          errors.push(server.serverId);
          return null;
        }
      }),
    ).then((ids) => {
      if (!abort.signal.aborted)
        setAvailable({
          key,
          errors,
          ids: ids.filter((id): id is string => id !== null),
        });
    });
    return () => abort.abort();
  }, [key, attempt]);
  const ids = available.key === key ? available.ids : [];
  const sessions =
    scope && opened.key === key
      ? opened.ids.flatMap((id) => {
          const server = servers.find((item) => item.serverId === id);
          return server && ids.includes(id)
            ? [
                {
                  ...server,
                  panel: (
                    <ServerSettingsPanel
                      key={`${key}:${id}`}
                      scope={scope}
                      serverId={id}
                      serverName={server.name}
                    />
                  ),
                },
              ]
            : [];
        })
      : [];
  const selected =
    selection?.key === key
      ? sessions.find((server) => server.serverId === selection.serverId)
      : undefined;
  function open(serverId: string) {
    if (!ids.includes(serverId)) return;
    setOpened((old) => ({
      key,
      ids:
        old.key === key
          ? Array.from(new Set([...old.ids, serverId]))
          : [serverId],
    }));
    setSelection({ key, serverId });
  }
  return {
    availableServerIds: ids,
    failedServerIds: available.key === key ? available.errors : [],
    retryDiscovery: () => setAttempt((n) => n + 1),
    open,
    hide() {
      setSelection(null);
    },
    close(serverId = selected?.serverId) {
      if (!serverId) return;
      setOpened((old) => ({
        ...old,
        ids: old.ids.filter((id) => id !== serverId),
      }));
      setSelection((old) => (old?.serverId === serverId ? null : old));
    },
    sessions,
    activeServerId: selected?.serverId ?? null,
    panel: selected?.panel ?? null,
  };
}
