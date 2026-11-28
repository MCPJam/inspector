import { useCallback, useEffect, useRef } from "react";
import { confirmAutoOAuthEscalation } from "@/lib/oauth/auto-oauth-escalation";
import { indexProjectServersByName } from "@/lib/project-servers-by-name";
import type { RemoteServer } from "./useProjects";

export function useServerConnectionOperations(
  projectId: string,
  servers: RemoteServer[] | undefined,
) {
  const tokens = useRef(new Map<string, number>());
  const prompts = useRef(new Map<string, AbortController>());
  const previousCatalog = useRef<{
    projectId: string;
    servers: RemoteServer[];
  } | null>(null);

  const getOpToken = useCallback(
    (name: string) => tokens.current.get(name) ?? 0,
    [],
  );
  const nextOpToken = useCallback(
    (name: string) => {
      const token = getOpToken(name) + 1;
      tokens.current.set(name, token);
      prompts.current.get(name)?.abort();
      return token;
    },
    [getOpToken],
  );
  const isStaleOp = useCallback(
    (name: string, token: number) => getOpToken(name) !== token,
    [getOpToken],
  );

  useEffect(() => {
    const serverTokens = tokens.current;
    return () => {
      for (const name of serverTokens.keys()) nextOpToken(name);
    };
  }, [nextOpToken]);

  useEffect(() => {
    if (!servers) return;
    const previous = previousCatalog.current;
    previousCatalog.current = { projectId, servers };
    if (previous?.projectId !== projectId) return;

    // A deletion in another tab never calls this tab's disconnect handler.
    if (prompts.current.size === 0) return;
    const previousByName = indexProjectServersByName(previous.servers, projectId);
    for (const name of prompts.current.keys()) {
      const row = previousByName.get(name);
      if (
        row &&
        !servers.some((server) => server._id === row._id && server.name === name)
      ) {
        nextOpToken(name);
      }
    }
  }, [nextOpToken, projectId, servers]);

  const requestAutoOAuthAuthorization = useCallback(
    async (name: string, token: number) => {
      if (isStaleOp(name, token)) return false;
      const controller = new AbortController();
      prompts.current.set(name, controller);
      try {
        return await confirmAutoOAuthEscalation(name, controller.signal);
      } finally {
        if (prompts.current.get(name) === controller) {
          prompts.current.delete(name);
        }
      }
    },
    [isStaleOp],
  );

  return { getOpToken, nextOpToken, isStaleOp, requestAutoOAuthAuthorization };
}
