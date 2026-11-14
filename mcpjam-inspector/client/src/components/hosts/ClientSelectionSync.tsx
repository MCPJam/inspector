import { useEffect } from "react";
import { useConvexAuth } from "convex/react";
import { useHostList, useHostMutations } from "@/hooks/useClients";
import { usePreviewedHostId } from "@/hooks/use-previewed-client-id";
import { useProjectClientInitialization } from "@/hooks/use-project-client-initialization";
import { usePreferencesStore } from "@/stores/preferences/preferences-provider";

const DEFAULT_CLIENT_NAME = "MCPJam";

/** Preserve project initialization independently of the client selector UI. */
export function ClientSelectionSync({ projectId }: { projectId: string }) {
  const { isAuthenticated } = useConvexAuth();
  // `isLoading` holds until the user row is ready and the list has loaded.
  const { hosts, isLoading } = useHostList({ isAuthenticated, projectId });
  const { ensureProjectClient } = useHostMutations();
  const themeMode = usePreferencesStore((s) => s.themeMode);
  const [previewedHostId, setPreviewedHostId] = usePreviewedHostId(projectId);

  // Every role: the client belongs to the project, and a member who opens an
  // empty one has no other way to get it. The state is shown by the client
  // selector through `useProjectClientInitStatus`.
  useProjectClientInitialization({
    projectId,
    intent: "default",
    needed: isAuthenticated && !isLoading && hosts.length === 0,
    run: (pid) => ensureProjectClient({ projectId: pid, themeMode }),
  });

  useEffect(() => {
    if (isLoading || hosts.some((h) => h.hostId === previewedHostId)) return;
    const fallback =
      hosts.find((h) => h.name === DEFAULT_CLIENT_NAME) ??
      [...hosts].sort((a, b) => a.name.localeCompare(b.name))[0];
    if (fallback) setPreviewedHostId(fallback.hostId);
  }, [hosts, isLoading, previewedHostId, setPreviewedHostId]);

  return null;
}
