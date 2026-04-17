import { useMemo } from "react";
import { useSharedAppState } from "@/state/app-state-context";
import { useWorkspaceMembers } from "@/hooks/useWorkspaces";
import { useAvailableEvalModels } from "@/hooks/use-available-eval-models";
import {
  isMCPJamGuestAllowedModel,
  isMCPJamProvidedModel,
} from "@/shared/types";

const GUEST_LOCKED_MODEL_REASON = "Sign in to use MCPJam provided models";

export function useEvalTabContext({
  isAuthenticated,
  workspaceId,
  isDirectGuest = false,
}: {
  isAuthenticated: boolean;
  workspaceId: string | null;
  isDirectGuest?: boolean;
}) {
  const appState = useSharedAppState();
  const { availableModels: rawAvailableModels } = useAvailableEvalModels();
  const { members, canManageMembers } = useWorkspaceMembers({
    isAuthenticated: isDirectGuest ? false : isAuthenticated,
    workspaceId: isDirectGuest ? null : workspaceId,
  });

  const connectedServerNames = useMemo(
    () =>
      new Set(
        Object.entries(appState.servers)
          .filter(([, server]) => server.connectionStatus === "connected")
          .map(([name]) => name),
      ),
    [appState.servers],
  );

  // Mirror chat's guest model policy: keep the same hosted models visible but
  // disable any MCPJam-provided model that guests cannot run.
  const availableModels = useMemo(() => {
    if (!isDirectGuest) return rawAvailableModels;
    return rawAvailableModels
      .filter((model) => isMCPJamProvidedModel(String(model.id)))
      .map((model) => {
        const modelId = String(model.id);
        if (isMCPJamGuestAllowedModel(modelId)) {
          return model;
        }
        return {
          ...model,
          disabled: true,
          disabledReason: GUEST_LOCKED_MODEL_REASON,
        };
      });
  }, [isDirectGuest, rawAvailableModels]);

  // Suite visibility already implies suite access; let the backend mutation
  // remain the source of truth for whether deletion is allowed.
  const canDeleteSuite = true;
  const canDeleteRuns = isDirectGuest || !workspaceId || canManageMembers;

  const userMap = useMemo(() => {
    if (isDirectGuest) return new Map<string, { name: string; imageUrl?: string }>();
    if (!members) return undefined;
    const map = new Map<string, { name: string; imageUrl?: string }>();
    for (const member of members) {
      if (member.userId && member.user) {
        map.set(member.userId, {
          name: member.user.name,
          imageUrl: member.user.imageUrl,
        });
      }
    }
    return map;
  }, [members, isDirectGuest]);

  return {
    connectedServerNames,
    userMap,
    canDeleteSuite,
    canDeleteRuns,
    availableModels,
  };
}
