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
  useWorkspaceQueries,
  useWorkspaceServers,
} from "@/hooks/useWorkspaces";
import { readBuilderSession, clearBuilderSession } from "@/lib/chatbox-session";
import { ChatboxIndexPage, type ChatboxOpenOptions } from "./ChatboxIndexPage";
import { ChatboxBuilderView } from "./ChatboxBuilderView";
import { ChatboxLauncher } from "./ChatboxLauncher";
import { getDefaultHostedModelId } from "./drafts";
import type { ChatboxDraftConfig, ChatboxStarterDefinition } from "./types";

interface ChatboxBuilderExperienceProps {
  workspaceId: string | null;
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
  workspaceId,
  isCreateChatboxDisabled = false,
  isCreateChatboxLoading = false,
  createChatboxUpsell = null,
}: ChatboxBuilderExperienceProps) {
  const { isAuthenticated } = useConvexAuth();
  const { chatboxes, isLoading } = useChatboxList({
    isAuthenticated,
    workspaceId,
  });
  const { deleteChatbox, duplicateChatbox } = useChatboxMutations();
  const { workspaces = [] } = useWorkspaceQueries({ isAuthenticated });
  const { servers = [] } = useWorkspaceServers({
    isAuthenticated,
    workspaceId,
  });
  const workspaceName =
    workspaces.find((workspace) => workspace._id === workspaceId)?.name ?? null;

  const [selectedChatboxId, setSelectedChatboxId] = useState<string | null>(
    null,
  );
  const [draft, setDraft] = useState<ChatboxDraftConfig | null>(null);
  const [restoredViewMode, setRestoredViewMode] = useState<
    "setup" | "preview" | "usage" | undefined
  >();
  const [starterLauncherOpen, setStarterLauncherOpen] = useState(false);
  const [deletingChatboxId, setDeletingChatboxId] = useState<string | null>(
    null,
  );
  const [duplicatingChatboxId, setDuplicatingChatboxId] = useState<
    string | null
  >(null);

  // Restore builder session from sessionStorage when workspaceId becomes
  // available. After an OAuth redirect the page reloads and Convex needs to
  // reconnect, so workspaceId is null on the first render — useState
  // initializers would miss the saved session.
  const restoredForWorkspaceRef = useRef<string | null>(null);
  useEffect(() => {
    if (!workspaceId) return;
    if (isCreateChatboxLoading) return;
    if (restoredForWorkspaceRef.current === workspaceId) return;
    restoredForWorkspaceRef.current = workspaceId;

    const session = readBuilderSession(workspaceId);
    if (!session || (!session.chatboxId && !session.draft)) return;
    if (!session.chatboxId && isCreateChatboxDisabled) {
      clearBuilderSession();
      return;
    }

    startTransition(() => {
      setSelectedChatboxId(session.chatboxId);
      setDraft((session.draft as ChatboxDraftConfig | null) ?? null);
      const vm = session.viewMode;
      if (vm === "builder") {
        setRestoredViewMode("setup");
      } else if (vm === "insights") {
        setRestoredViewMode("usage");
      } else {
        setRestoredViewMode(vm as "setup" | "preview" | "usage" | undefined);
      }
    });
  }, [isCreateChatboxDisabled, isCreateChatboxLoading, workspaceId]);

  const applyStarterDraft = useCallback(
    (starter: ChatboxStarterDefinition) => {
      if (isCreateChatboxDisabled || isCreateChatboxLoading) {
        return;
      }
      startTransition(() => {
        setSelectedChatboxId(null);
        setDraft(starter.createDraft(getDefaultHostedModelId()));
        setRestoredViewMode(undefined);
        setStarterLauncherOpen(false);
      });
    },
    [isCreateChatboxDisabled, isCreateChatboxLoading],
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

  if (!workspaceId) {
    return (
      <div className="flex h-full items-center justify-center">
        <p className="text-sm text-muted-foreground">
          Select a workspace to manage chatboxes.
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
          workspaceId={workspaceId}
          workspaceName={workspaceName}
          workspaceServers={servers}
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
          isLoading={isLoading}
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
