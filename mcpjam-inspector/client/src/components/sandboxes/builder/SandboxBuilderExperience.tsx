import {
  startTransition,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { useConvexAuth } from "convex/react";
import { toast } from "sonner";
import {
  useSandboxList,
  useSandboxMutations,
  type SandboxListItem,
  type SandboxSettings,
} from "@/hooks/useSandboxes";
import {
  useWorkspaceQueries,
  useWorkspaceServers,
} from "@/hooks/useWorkspaces";
import { readBuilderSession, clearBuilderSession } from "@/lib/sandbox-session";
import { SandboxIndexPage, type SandboxOpenOptions } from "./SandboxIndexPage";
import { SandboxBuilderView } from "./SandboxBuilderView";
import { SandboxLauncher } from "./SandboxLauncher";
import { getDefaultHostedModelId } from "./drafts";
import type { SandboxDraftConfig, SandboxStarterDefinition } from "./types";

interface SandboxBuilderExperienceProps {
  workspaceId: string | null;
  isCreateSandboxDisabled?: boolean;
  isCreateSandboxLoading?: boolean;
  createSandboxUpsell?: {
    title: string;
    message: string;
    teaser?: string | null;
    canManageBilling: boolean;
    ctaLabel: string;
    onNavigateToBilling: () => void;
  } | null;
}

export default function SandboxBuilderExperience({
  workspaceId,
  isCreateSandboxDisabled = false,
  isCreateSandboxLoading = false,
  createSandboxUpsell = null,
}: SandboxBuilderExperienceProps) {
  const { isAuthenticated } = useConvexAuth();
  const { sandboxes, isLoading } = useSandboxList({
    isAuthenticated,
    workspaceId,
  });
  const { deleteSandbox, duplicateSandbox } = useSandboxMutations();
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
    "setup" | "preview" | "usage" | undefined
  >();
  const [starterLauncherOpen, setStarterLauncherOpen] = useState(false);
  const [deletingSandboxId, setDeletingSandboxId] = useState<string | null>(
    null,
  );
  const [duplicatingSandboxId, setDuplicatingSandboxId] = useState<
    string | null
  >(null);

  // Restore builder session from sessionStorage when workspaceId becomes
  // available. After an OAuth redirect the page reloads and Convex needs to
  // reconnect, so workspaceId is null on the first render — useState
  // initializers would miss the saved session.
  const restoredForWorkspaceRef = useRef<string | null>(null);
  useEffect(() => {
    if (!workspaceId) return;
    if (isCreateSandboxLoading) return;
    if (restoredForWorkspaceRef.current === workspaceId) return;
    restoredForWorkspaceRef.current = workspaceId;

    const session = readBuilderSession(workspaceId);
    if (!session || (!session.sandboxId && !session.draft)) return;
    if (!session.sandboxId && isCreateSandboxDisabled) {
      clearBuilderSession();
      return;
    }

    startTransition(() => {
      setSelectedSandboxId(session.sandboxId);
      setDraft((session.draft as SandboxDraftConfig | null) ?? null);
      const vm = session.viewMode;
      if (vm === "builder") {
        setRestoredViewMode("setup");
      } else if (vm === "insights") {
        setRestoredViewMode("usage");
      } else {
        setRestoredViewMode(vm as "setup" | "preview" | "usage" | undefined);
      }
    });
  }, [isCreateSandboxDisabled, isCreateSandboxLoading, workspaceId]);

  const applyStarterDraft = useCallback(
    (starter: SandboxStarterDefinition) => {
      if (isCreateSandboxDisabled || isCreateSandboxLoading) {
        return;
      }
      startTransition(() => {
        setSelectedSandboxId(null);
        setDraft(starter.createDraft(getDefaultHostedModelId()));
        setRestoredViewMode(undefined);
        setStarterLauncherOpen(false);
      });
    },
    [isCreateSandboxDisabled, isCreateSandboxLoading],
  );

  const handleOpenStarterLauncher = useCallback(() => {
    setStarterLauncherOpen(true);
  }, []);

  const handleSelectStarterFromLauncher = useCallback(
    (starter: SandboxStarterDefinition) => {
      applyStarterDraft(starter);
    },
    [applyStarterDraft],
  );

  const handleSavedDraft = useCallback((sandbox: SandboxSettings) => {
    startTransition(() => {
      setDraft(null);
      setSelectedSandboxId(sandbox.sandboxId);
      setRestoredViewMode(undefined);
    });
  }, []);

  const handleDeleteSandbox = useCallback(
    async (sandbox: SandboxListItem) => {
      setDeletingSandboxId(sandbox.sandboxId);
      try {
        await deleteSandbox({ sandboxId: sandbox.sandboxId });
        toast.success("Sandbox deleted");
      } catch (error) {
        toast.error(
          error instanceof Error ? error.message : "Failed to delete sandbox",
        );
        throw error;
      } finally {
        setDeletingSandboxId(null);
      }
    },
    [deleteSandbox],
  );

  const handleDuplicateSandbox = useCallback(
    async (sandbox: SandboxListItem) => {
      setDuplicatingSandboxId(sandbox.sandboxId);
      try {
        const result = (await duplicateSandbox({
          sandboxId: sandbox.sandboxId,
        })) as { sandboxId?: string } | null | undefined;
        const newId =
          result && typeof result === "object" && typeof result.sandboxId === "string"
            ? result.sandboxId
            : null;
        toast.success("Sandbox duplicated");
        if (newId) {
          startTransition(() => {
            setSelectedSandboxId(newId);
            setRestoredViewMode(undefined);
          });
        }
      } catch (error) {
        toast.error(
          error instanceof Error ? error.message : "Failed to duplicate sandbox",
        );
        throw error;
      } finally {
        setDuplicatingSandboxId(null);
      }
    },
    [duplicateSandbox],
  );

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
      <SandboxLauncher
        open={starterLauncherOpen}
        onOpenChange={setStarterLauncherOpen}
        onSelectStarter={handleSelectStarterFromLauncher}
      />
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
          onOpenSandbox={(
            sandboxId: string,
            options?: SandboxOpenOptions,
          ) => {
            startTransition(() => {
              setSelectedSandboxId(sandboxId);
              setRestoredViewMode(options?.initialViewMode);
            });
          }}
          onDuplicateSandbox={handleDuplicateSandbox}
          onDeleteSandbox={handleDeleteSandbox}
          deletingSandboxId={deletingSandboxId}
          duplicatingSandboxId={duplicatingSandboxId}
          onOpenStarterLauncher={handleOpenStarterLauncher}
          onSelectStarter={applyStarterDraft}
          isCreateSandboxDisabled={isCreateSandboxDisabled}
          isCreateSandboxLoading={isCreateSandboxLoading}
          createSandboxUpsell={createSandboxUpsell}
        />
      )}
    </>
  );
}
