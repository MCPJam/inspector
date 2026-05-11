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
import type { ChatboxDraftConfig, ChatboxStarterDefinition } from "./types";
import { useChatboxDemoSeed } from "./useChatboxDemoSeed";

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
}

export default function ChatboxBuilderExperience({
  projectId,
  isCreateChatboxDisabled = false,
  isCreateChatboxLoading = false,
  createChatboxUpsell = null,
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

  // Auto-open the freshly seeded demo exactly once. Without the ref, the
  // effect re-fires after the user clicks "Return to chatboxes" (which
  // clears selectedChatboxId/draft) and bounces them straight back into
  // the builder.
  const autoOpenedSeedRef = useRef(false);
  useEffect(() => {
    if (!seededChatboxId) return;
    if (autoOpenedSeedRef.current) return;
    // Don't yank the user out of a builder/preview they already opened.
    if (selectedChatboxId || draft) return;
    autoOpenedSeedRef.current = true;
    startTransition(() => {
      setSelectedChatboxId(seededChatboxId);
      setRestoredViewMode("preview");
    });
  }, [draft, seededChatboxId, selectedChatboxId]);

  // Restore builder session from sessionStorage when projectId becomes
  // available. After an OAuth redirect the page reloads and Convex needs to
  // reconnect, so projectId is null on the first render — useState
  // initializers would miss the saved session.
  const restoredForProjectRef = useRef<string | null>(null);
  useEffect(() => {
    if (!projectId) return;
    if (isCreateChatboxLoading) return;
    if (restoredForProjectRef.current === projectId) return;
    restoredForProjectRef.current = projectId;

    const session = readBuilderSession(projectId);
    if (!session || (!session.chatboxId && !session.draft)) return;
    if (!session.chatboxId && isCreateChatboxDisabled) {
      clearBuilderSession();
      return;
    }

    startTransition(() => {
      setSelectedChatboxId(session.chatboxId);
      // Phase 4: migrate any older-shape draft (missing fields added
      // since the draft was persisted) into the current shape before
      // handing it to the builder.
      setDraft(migrateBuilderDraft(session.draft) ?? null);
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
  }, [isCreateChatboxDisabled, isCreateChatboxLoading, projectId]);

  const applyStarterDraft = useCallback(
    async (starter: ChatboxStarterDefinition) => {
      if (isCreateChatboxDisabled || isCreateChatboxLoading) {
        return;
      }

      // Resolve any pre-attached server seeds against the project: reuse a
      // server with a matching URL when present, otherwise mint a new
      // RemoteServer row so the saved chatbox is usable on first save.
      // Failure to seed is non-fatal — fall through to a server-less draft.
      const seededServerIds: string[] = [];
      if (projectId && starter.serverSeeds?.length) {
        for (const seed of starter.serverSeeds) {
          const existing = servers.find(
            (s) => s.transportType === "http" && s.url === seed.url,
          );
          if (existing) {
            seededServerIds.push(existing._id);
            continue;
          }
          try {
            const id = (await createServer({
              projectId,
              name: seed.name,
              enabled: true,
              transportType: "http",
              url: seed.url,
            } as any)) as string;
            if (id) seededServerIds.push(id);
          } catch (error) {
            toast.error(
              error instanceof Error
                ? error.message
                : `Failed to attach ${seed.name} to the demo`,
            );
          }
        }
      }

      const baseDraft = starter.createDraft(getDefaultHostedModelId());
      const nextDraft: ChatboxDraftConfig = seededServerIds.length
        ? { ...baseDraft, selectedServerIds: seededServerIds }
        : baseDraft;

      startTransition(() => {
        setSelectedChatboxId(null);
        setDraft(nextDraft);
        setRestoredViewMode(undefined);
        setStarterLauncherOpen(false);
      });
    },
    [
      createServer,
      isCreateChatboxDisabled,
      isCreateChatboxLoading,
      projectId,
      servers,
    ],
  );

  const handleOpenStarterLauncher = useCallback(() => {
    setStarterLauncherOpen(true);
  }, []);

  const handleSelectStarterFromLauncher = useCallback(
    (starter: ChatboxStarterDefinition) => {
      applyStarterDraft(starter);
    },
    [applyStarterDraft],
  );

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
        onSelectStarter={handleSelectStarterFromLauncher}
      />
      {isBuilderOpen ? (
        <ChatboxBuilderView
          projectId={projectId}
          projectName={projectName}
          projectServers={servers}
          chatboxId={selectedChatboxId}
          draft={draft}
          initialViewMode={restoredViewMode}
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
          onSelectStarter={applyStarterDraft}
          isCreateChatboxDisabled={isCreateChatboxDisabled}
          isCreateChatboxLoading={isCreateChatboxLoading}
          createChatboxUpsell={createChatboxUpsell}
        />
      )}
    </>
  );
}
