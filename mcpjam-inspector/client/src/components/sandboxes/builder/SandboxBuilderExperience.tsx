import {
  startTransition,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { useConvexAuth } from "convex/react";
import { useSandboxList, type SandboxSettings } from "@/hooks/useSandboxes";
import {
  useWorkspaceQueries,
  useWorkspaceServers,
} from "@/hooks/useWorkspaces";
import { readBuilderSession, clearBuilderSession } from "@/lib/sandbox-session";
import { SandboxIndexPage } from "./SandboxIndexPage";
import { SandboxBuilderView } from "./SandboxBuilderView";
import { getDefaultHostedModelId, SANDBOX_STARTERS } from "./drafts";
import type { SandboxDraftConfig } from "./types";

interface SandboxBuilderExperienceProps {
  workspaceId: string | null;
}

export default function SandboxBuilderExperience({
  workspaceId,
}: SandboxBuilderExperienceProps) {
  const { isAuthenticated } = useConvexAuth();
  const { sandboxes, isLoading } = useSandboxList({
    isAuthenticated,
    workspaceId,
  });
  const { workspaces = [] } = useWorkspaceQueries({ isAuthenticated });
  const { servers = [] } = useWorkspaceServers({
    isAuthenticated,
    workspaceId,
  });
  const workspaceName =
    workspaces.find((workspace) => workspace._id === workspaceId)?.name ?? null;

  const [selectedSandboxId, setSelectedSandboxId] = useState<string | null>(
    null,
  );
  const [draft, setDraft] = useState<SandboxDraftConfig | null>(null);
  const [restoredViewMode, setRestoredViewMode] = useState<
    "builder" | "insights" | "preview" | undefined
  >();

  // Restore builder session from sessionStorage when workspaceId becomes
  // available. After an OAuth redirect the page reloads and Convex needs to
  // reconnect, so workspaceId is null on the first render — useState
  // initializers would miss the saved session.
  const restoredForWorkspaceRef = useRef<string | null>(null);
  useEffect(() => {
    if (!workspaceId) return;
    if (restoredForWorkspaceRef.current === workspaceId) return;
    restoredForWorkspaceRef.current = workspaceId;

    const session = readBuilderSession(workspaceId);
    if (!session || (!session.sandboxId && !session.draft)) return;

    startTransition(() => {
      setSelectedSandboxId(session.sandboxId);
      setDraft((session.draft as SandboxDraftConfig | null) ?? null);
      setRestoredViewMode(
        session.viewMode as "builder" | "insights" | "preview" | undefined,
      );
    });
  }, [workspaceId]);

  const handleCreateSandbox = useCallback(() => {
    const blankStarter = SANDBOX_STARTERS.find((s) => s.id === "blank")!;
    startTransition(() => {
      setSelectedSandboxId(null);
      setDraft(blankStarter.createDraft(getDefaultHostedModelId()));
      setRestoredViewMode(undefined);
    });
  }, []);

  const handleSavedDraft = useCallback((sandbox: SandboxSettings) => {
    startTransition(() => {
      setDraft(null);
      setSelectedSandboxId(sandbox.sandboxId);
      setRestoredViewMode(undefined);
    });
  }, []);

  if (!workspaceId) {
    return (
      <div className="flex h-full items-center justify-center">
        <p className="text-sm text-muted-foreground">
          Select a workspace to manage sandboxes.
        </p>
      </div>
    );
  }

  const isBuilderOpen = !!draft || !!selectedSandboxId;

  return (
    <>
      {isBuilderOpen ? (
        <SandboxBuilderView
          workspaceId={workspaceId}
          workspaceName={workspaceName}
          workspaceServers={servers}
          sandboxId={selectedSandboxId}
          draft={draft}
          initialViewMode={restoredViewMode}
          onSavedDraft={handleSavedDraft}
          onBack={() => {
            clearBuilderSession();
            startTransition(() => {
              setSelectedSandboxId(null);
              setDraft(null);
              setRestoredViewMode(undefined);
            });
          }}
        />
      ) : (
        <SandboxIndexPage
          sandboxes={sandboxes}
          isLoading={isLoading}
          onOpenSandbox={(sandboxId) =>
            startTransition(() => {
              setSelectedSandboxId(sandboxId);
              setRestoredViewMode(undefined);
            })
          }
          onCreateSandbox={handleCreateSandbox}
        />
      )}
    </>
  );
}
