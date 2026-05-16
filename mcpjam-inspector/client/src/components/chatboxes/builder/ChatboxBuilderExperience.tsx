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
  useChatboxList,
  useChatboxMutations,
  type ChatboxListItem,
  type ChatboxSettings,
} from "@/hooks/useChatboxes";
import {
  useProjectQueries,
  useProjectServers,
  useServerMutations,
} from "@/hooks/useProjects";
import { readBuilderSession, clearBuilderSession } from "@/lib/chatbox-session";
import { ChatboxIndexPage, type ChatboxOpenOptions } from "./ChatboxIndexPage";
import { ChatboxBuilderView } from "./ChatboxBuilderView";
import { ChatboxLauncher } from "./ChatboxLauncher";
import { getDefaultHostedModelId, migrateBuilderDraft } from "./drafts";
import type { ChatboxDraftConfig } from "./types";
import { useChatboxDemoSeed } from "./useChatboxDemoSeed";
import type { EnsureServersReadyResult } from "@/hooks/use-app-state";

interface ChatboxBuilderExperienceProps {
  projectId: string | null;
  isCreateChatboxDisabled?: boolean;
  isCreateChatboxLoading?: boolean;
  createChatboxUpsell?: {
    title: string;
    message: string;
    teaser?: string | null;
    canManageBilling: boolean;
    ctaLabel: string;
    onNavigateToBilling: () => void;
  } | null;
  ensureServersReady?: (
    serverNames: string[],
  ) => Promise<EnsureServersReadyResult>;
}

export default function ChatboxBuilderExperience({
  projectId,
  isCreateChatboxDisabled = false,
  isCreateChatboxLoading = false,
  createChatboxUpsell = null,
  ensureServersReady,
}: ChatboxBuilderExperienceProps) {
  const { isAuthenticated } = useConvexAuth();
  const { chatboxes, isLoading } = useChatboxList({
    isAuthenticated,
    projectId,
  });
  const { deleteChatbox, duplicateChatbox } = useChatboxMutations();
  const { projects = [] } = useProjectQueries({ isAuthenticated });
  const { servers = [] } = useProjectServers({
    isAuthenticated,
    projectId,
  });
  const { createServer } = useServerMutations();
  const projectName =
    projects.find((w) => w._id === projectId)?.name ?? null;

  const [selectedChatboxId, setSelectedChatboxId] = useState<string | null>(
    null,
  );
  const [draft, setDraft] = useState<ChatboxDraftConfig | null>(null);
  const [restoredViewMode, setRestoredViewMode] = useState<
    "setup" | "preview" | "usage" | "insights" | undefined
  >();
  const [starterLauncherOpen, setStarterLauncherOpen] = useState(false);
  const [deletingChatboxId, setDeletingChatboxId] = useState<string | null>(
    null,
  );
  const [duplicatingChatboxId, setDuplicatingChatboxId] = useState<
    string | null
  >(null);

  // First-run auto-seed: when a project has zero chatboxes and we
  // haven't tried before, mint the Excalidraw demo + open it directly
  // in preview so the user starts typing instead of staring at an
  // empty index.
  const { seededChatboxId, isSeeding } = useChatboxDemoSeed({
    isAuthenticated,
    projectId,
    chatboxes,
    isLoadingChatboxes: isLoading,
    isCreateChatboxDisabled,
  });

  // Auto-open the freshly seeded demo exactly once. Latch the ref the
  // first time we observe `seededChatboxId` regardless of whether we
  // actually open it: if the user is already inside a restored session
  // we want to leave them there, but we must *not* re-fire after they
  // later click "Return to chatboxes" (which clears
  // selectedChatboxId/draft) — that would bounce them back into the
  // builder, the exact regression this guard exists to prevent.
  const autoOpenedSeedRef = useRef(false);
  useEffect(() => {
    if (!seededChatboxId) return;
    if (autoOpenedSeedRef.current) return;
    autoOpenedSeedRef.current = true;
    if (selectedChatboxId || draft) return;
    startTransition(() => {
      setSelectedChatboxId(seededChatboxId);
      setRestoredViewMode("preview");
    });
  }, [draft, seededChatboxId, selectedChatboxId]);

  // Restore builder session from sessionStorage when projectId becomes
  // available. After an OAuth redirect the page reloads and Convex needs to
  // reconnect, so projectId is null on the first render — useState
  // initializers would miss the saved session.
  //
  // We also wait for the chatboxes list to resolve so we can validate
  // session.chatboxId against it: a stale id (deleted chatbox, different
  // Convex deploy after `npm run dev`, account switch) would otherwise
  // crash the React tree when ChatboxBuilderView's getChatboxConfig query
  // throws "Chatbox not found".
  const restoredForProjectRef = useRef<string | null>(null);
  useEffect(() => {
    if (!projectId) return;
    if (isCreateChatboxLoading) return;
    if (isLoading) return;
    if (chatboxes === undefined) return;
    if (restoredForProjectRef.current === projectId) return;

    const session = readBuilderSession(projectId);
    if (!session || (!session.chatboxId && !session.draft)) {
      restoredForProjectRef.current = projectId;
      return;
    }
    if (!session.chatboxId && isCreateChatboxDisabled) {
      clearBuilderSession();
      restoredForProjectRef.current = projectId;
      return;
    }

    // Drop the saved chatboxId if the current chatboxes list doesn't
    // include it — the chatbox was deleted, the user switched accounts,
    // or this dev server points at a different Convex deploy than the
    // one that minted the session.
    const restoredChatboxId =
      session.chatboxId &&
      chatboxes.some((c) => c.chatboxId === session.chatboxId)
        ? session.chatboxId
        : null;
    const restoredDraft = migrateBuilderDraft(session.draft) ?? null;

    if (!restoredChatboxId && !restoredDraft) {
      clearBuilderSession();
      restoredForProjectRef.current = projectId;
      return;
    }

    restoredForProjectRef.current = projectId;

    startTransition(() => {
      setSelectedChatboxId(restoredChatboxId);
      setDraft(restoredDraft);
      const vm = session.viewMode;
      if (vm === "builder") {
        setRestoredViewMode("setup");
      } else if (vm === "insights") {
        setRestoredViewMode("insights");
      } else {
        setRestoredViewMode(
          vm as "setup" | "preview" | "usage" | "insights" | undefined,
        );
      }
    });
  }, [
    chatboxes,
    isCreateChatboxDisabled,
    isCreateChatboxLoading,
    isLoading,
    projectId,
  ]);

  // Under live-reference, "starter drafts" no longer exist — the
  // launcher creates the chatbox directly against a picked host. The
  // legacy applyStarterDraft helper that minted seed servers + a draft
  // ChatboxConfig was removed. The hooks that used to flow through it
  // (servers, createServer, getDefaultHostedModelId) stay for adjacent
  // host-create flows we may add later.
  void servers;
  void createServer;
  void getDefaultHostedModelId;
  void setDraft;
  void setRestoredViewMode;

  const handleOpenStarterLauncher = useCallback(() => {
    setStarterLauncherOpen(true);
  }, []);

  const handleSavedDraft = useCallback((chatbox: ChatboxSettings) => {
    startTransition(() => {
      setDraft(null);
      setSelectedChatboxId(chatbox.chatboxId);
      setRestoredViewMode(undefined);
    });
  }, []);

  const handleDeleteChatbox = useCallback(
    async (chatbox: ChatboxListItem) => {
      setDeletingChatboxId(chatbox.chatboxId);
      try {
        await deleteChatbox({ chatboxId: chatbox.chatboxId });
        toast.success("Chatbox deleted");
      } catch (error) {
        toast.error(
          error instanceof Error ? error.message : "Failed to delete chatbox",
        );
        throw error;
      } finally {
        setDeletingChatboxId(null);
      }
    },
    [deleteChatbox],
  );

  const handleDuplicateChatbox = useCallback(
    async (chatbox: ChatboxListItem) => {
      setDuplicatingChatboxId(chatbox.chatboxId);
      try {
        const result = (await duplicateChatbox({
          chatboxId: chatbox.chatboxId,
        })) as { chatboxId?: string } | null | undefined;
        const newId =
          result &&
          typeof result === "object" &&
          typeof result.chatboxId === "string"
            ? result.chatboxId
            : null;
        toast.success("Chatbox duplicated");
        if (newId) {
          startTransition(() => {
            setSelectedChatboxId(newId);
            setRestoredViewMode(undefined);
          });
        }
      } catch (error) {
        toast.error(
          error instanceof Error
            ? error.message
            : "Failed to duplicate chatbox",
        );
        throw error;
      } finally {
        setDuplicatingChatboxId(null);
      }
    },
    [duplicateChatbox],
  );

  if (!projectId) {
    return (
      <div className="flex h-full items-center justify-center">
        <p className="text-sm text-muted-foreground">
          Select a project to manage chatboxes.
        </p>
      </div>
    );
  }

  const isBuilderOpen = !!draft || !!selectedChatboxId;

  return (
    <>
      <ChatboxLauncher
        open={starterLauncherOpen}
        onOpenChange={setStarterLauncherOpen}
        projectId={projectId}
        onChatboxCreated={handleSavedDraft}
      />
      {isBuilderOpen ? (
        <ChatboxBuilderView
          projectId={projectId}
          projectName={projectName}
          projectServers={servers}
          chatboxId={selectedChatboxId}
          draft={draft}
          initialViewMode={restoredViewMode}
          ensureServersReady={ensureServersReady}
          onSavedDraft={handleSavedDraft}
          onBack={() => {
            clearBuilderSession();
            startTransition(() => {
              setSelectedChatboxId(null);
              setDraft(null);
              setRestoredViewMode(undefined);
            });
          }}
        />
      ) : (
        <ChatboxIndexPage
          chatboxes={chatboxes}
          isLoading={isLoading || isSeeding}
          onOpenChatbox={(chatboxId: string, options?: ChatboxOpenOptions) => {
            startTransition(() => {
              setSelectedChatboxId(chatboxId);
              setRestoredViewMode(options?.initialViewMode);
            });
          }}
          onDuplicateChatbox={handleDuplicateChatbox}
          onDeleteChatbox={handleDeleteChatbox}
          deletingChatboxId={deletingChatboxId}
          duplicatingChatboxId={duplicatingChatboxId}
          onOpenStarterLauncher={handleOpenStarterLauncher}
          isCreateChatboxDisabled={isCreateChatboxDisabled}
          isCreateChatboxLoading={isCreateChatboxLoading}
          createChatboxUpsell={createChatboxUpsell}
        />
      )}
    </>
  );
}
