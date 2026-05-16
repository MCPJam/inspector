import { startTransition, useDeferredValue, useMemo, useState } from "react";
import {
  CreditCard,
  LayoutGrid,
  List,
  Loader2,
  Plus,
  Search,
} from "lucide-react";
import { formatDistanceToNow } from "date-fns";
import { Alert, AlertDescription, AlertTitle } from "@mcpjam/design-system/alert";
import { Button } from "@mcpjam/design-system/button";
import { Badge } from "@mcpjam/design-system/badge";
import { Card, CardInteractive } from "@mcpjam/design-system/card";
import { Input } from "@mcpjam/design-system/input";
import type { ChatboxListItem } from "@/hooks/useChatboxes";
import { getChatboxHostStyleShortLabel } from "@/lib/chatbox-host-style";
import { ChatboxDeleteConfirmDialog } from "@/components/chatboxes/ChatboxDeleteConfirmDialog";
import { ChatboxIndexRowActionsMenu } from "./chatbox-index-row-actions";

export type ChatboxOpenOptions = {
  initialViewMode?: "setup" | "preview" | "usage" | "insights";
};

// ---------------------------------------------------------------------------
// ChatboxSummaryCard — info-first layout
// ---------------------------------------------------------------------------

function ChatboxSummaryCard({
  chatbox,
  onOpen,
  onEdit,
  onUsage,
  onDuplicate,
  onDelete,
  isDeleting,
  isDuplicating,
}: {
  chatbox: ChatboxListItem;
  onOpen: () => void;
  onEdit: () => void;
  onUsage: () => void;
  onDuplicate: () => void;
  onDelete: () => void;
  isDeleting: boolean;
  isDuplicating: boolean;
}) {
  const serverList =
    chatbox.serverNames.length > 0
      ? chatbox.serverNames.join(" · ")
      : "No servers configured";

  return (
    <CardInteractive className="flex flex-col gap-4" onClick={onOpen}>
      <div className="flex items-start justify-between gap-2">
        <h3 className="min-w-0 flex-1 truncate text-lg font-bold tracking-tight">
          {chatbox.name}
        </h3>
        <ChatboxIndexRowActionsMenu
          chatbox={chatbox}
          onEdit={onEdit}
          onUsage={onUsage}
          onDuplicate={onDuplicate}
          onDelete={onDelete}
          isDeleting={isDeleting}
          isDuplicating={isDuplicating}
        />
      </div>

      <p className="truncate text-sm text-muted-foreground">{serverList}</p>

      <p className="text-xs text-muted-foreground">
        Updated {formatDistanceToNow(chatbox.updatedAt, { addSuffix: true })}
      </p>
    </CardInteractive>
  );
}

// ---------------------------------------------------------------------------
// ChatboxIndexPage
// ---------------------------------------------------------------------------

interface ChatboxIndexPageProps {
  chatboxes: ChatboxListItem[] | undefined;
  isLoading: boolean;
  onOpenChatbox: (chatboxId: string, options?: ChatboxOpenOptions) => void;
  onDuplicateChatbox: (chatbox: ChatboxListItem) => void;
  onDeleteChatbox: (chatbox: ChatboxListItem) => void;
  /** Chatbox id currently being deleted (disables that row’s delete control). */
  deletingChatboxId?: string | null;
  /** Chatbox id currently being duplicated. */
  duplicatingChatboxId?: string | null;
  /** Opens the host-picker dialog (used by both the empty state CTA and the "New chatbox" button). */
  onOpenStarterLauncher: () => void;
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

export function ChatboxIndexPage({
  chatboxes,
  isLoading,
  onOpenChatbox,
  onDuplicateChatbox,
  onDeleteChatbox,
  deletingChatboxId = null,
  duplicatingChatboxId = null,
  onOpenStarterLauncher,
  isCreateChatboxDisabled = false,
  isCreateChatboxLoading = false,
  createChatboxUpsell = null,
}: ChatboxIndexPageProps) {
  const [query, setQuery] = useState("");
  const [viewMode, setViewMode] = useState<"cards" | "list">("cards");
  const [pendingDelete, setPendingDelete] = useState<ChatboxListItem | null>(
    null,
  );
  const deferredQuery = useDeferredValue(query);

  const filteredChatboxes = useMemo(() => {
    const normalized = deferredQuery.trim().toLowerCase();
    const base = [...(chatboxes ?? [])].filter((chatbox) => {
      if (!normalized) return true;
      return (
        chatbox.name.toLowerCase().includes(normalized) ||
        chatbox.description?.toLowerCase().includes(normalized) ||
        chatbox.serverNames.some((serverName) =>
          serverName.toLowerCase().includes(normalized),
        )
      );
    });

    base.sort((left, right) => right.updatedAt - left.updatedAt);

    return base;
  }, [deferredQuery, chatboxes]);

  const totalCount = chatboxes?.length ?? 0;
  const isFirstRunEmpty =
    !isLoading && totalCount === 0 && deferredQuery.trim() === "";
  const isSearchEmpty =
    !isLoading && totalCount > 0 && filteredChatboxes.length === 0;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <ChatboxDeleteConfirmDialog
        open={!!pendingDelete}
        onOpenChange={(open) => {
          if (!open) setPendingDelete(null);
        }}
        chatboxName={pendingDelete?.name ?? ""}
        isDeleting={
          !!pendingDelete && deletingChatboxId === pendingDelete.chatboxId
        }
        onConfirm={async () => {
          if (!pendingDelete) return;
          await onDeleteChatbox(pendingDelete);
        }}
      />
      <div className="border-b px-6 py-5">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h2 className="mt-2 text-3xl font-semibold">Chatboxes</h2>
          </div>
          <Button
            size="lg"
            className="gap-2 rounded-xl"
            onClick={onOpenStarterLauncher}
            disabled={isCreateChatboxDisabled || isCreateChatboxLoading}
          >
            <Plus className="size-4" />
            New chatbox
          </Button>
        </div>

        {!isFirstRunEmpty ? (
          <div className="mt-6 flex flex-wrap items-center gap-3">
            <div className="relative min-w-[260px] flex-1">
              <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={query}
                onChange={(event) => {
                  const nextValue = event.target.value;
                  startTransition(() => setQuery(nextValue));
                }}
                placeholder="Search chatboxes, servers, or descriptions"
                className="pl-9"
              />
            </div>

            <div className="flex items-center gap-2 rounded-xl border border-border/70 bg-card/60 p-1">
              <Button
                variant={viewMode === "cards" ? "secondary" : "ghost"}
                size="sm"
                className="rounded-lg"
                onClick={() => setViewMode("cards")}
              >
                <LayoutGrid className="mr-1.5 size-4" />
                Cards
              </Button>
              <Button
                variant={viewMode === "list" ? "secondary" : "ghost"}
                size="sm"
                className="rounded-lg"
                onClick={() => setViewMode("list")}
              >
                <List className="mr-1.5 size-4" />
                List
              </Button>
            </div>
          </div>
        ) : null}

        {createChatboxUpsell ? (
          <Alert
            className="mt-4 border-primary/20 bg-primary/[0.04]"
            data-testid="chatbox-limit-upsell"
          >
            <CreditCard className="size-4 text-primary" />
            <AlertTitle>{createChatboxUpsell.title}</AlertTitle>
            <AlertDescription className="gap-3">
              <div className="flex flex-col gap-3 md:flex-row md:items-end md:justify-between">
                <div className="space-y-1">
                  <p>{createChatboxUpsell.message}</p>
                  {createChatboxUpsell.teaser ? (
                    <p className="text-foreground/80">
                      {createChatboxUpsell.teaser}
                    </p>
                  ) : null}
                  {!createChatboxUpsell.canManageBilling ? (
                    <p className="font-medium text-foreground/80">
                      Ask an organization owner to review billing options.
                    </p>
                  ) : null}
                </div>
                {createChatboxUpsell.canManageBilling ? (
                  <Button
                    type="button"
                    size="sm"
                    className="md:self-end"
                    onClick={createChatboxUpsell.onNavigateToBilling}
                  >
                    {createChatboxUpsell.ctaLabel}
                  </Button>
                ) : null}
              </div>
            </AlertDescription>
          </Alert>
        ) : null}
      </div>

      <div className="flex-1 overflow-y-auto px-6 py-6">
        {isLoading ? (
          <div className="flex h-full items-center justify-center">
            <Loader2 className="size-5 animate-spin text-muted-foreground" />
          </div>
        ) : isFirstRunEmpty ? (
          <div className="flex min-h-full flex-col items-center justify-center px-2 py-4 sm:py-8">
            <div className="w-full max-w-md text-center animate-in fade-in slide-in-from-bottom-2 duration-500 motion-reduce:animate-none motion-reduce:opacity-100">
              <h4 className="text-[11px] font-semibold tracking-[0.22em] text-muted-foreground uppercase">
                Get started
              </h4>
              <h2 className="mt-3 text-2xl font-semibold tracking-tight">
                Create your first chatbox
              </h2>
              <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
                A chatbox is a shareable window onto one of your project's
                hosts. Pick a host to use its model, prompt, and servers — you
                can re-point the chatbox at a different host any time.
              </p>
              <Button
                size="lg"
                className="mt-6 gap-2 rounded-xl"
                onClick={onOpenStarterLauncher}
                disabled={isCreateChatboxDisabled || isCreateChatboxLoading}
              >
                <Plus className="size-4" />
                Pick a host
              </Button>
            </div>
          </div>
        ) : isSearchEmpty ? (
          <Card className="flex min-h-[320px] flex-col items-center justify-center rounded-[28px] border-dashed text-center">
            <div className="flex size-14 items-center justify-center rounded-2xl border border-border/60 bg-muted/30">
              <Search className="size-5 text-muted-foreground" />
            </div>
            <h3 className="mt-5 text-xl font-semibold">
              No matching chatboxes
            </h3>
            <p className="mt-2 max-w-md text-sm text-muted-foreground">
              Try a different search, or clear the filter to see all chatboxes.
            </p>
            <Button
              variant="outline"
              className="mt-5 rounded-xl"
              onClick={() => setQuery("")}
            >
              Clear search
            </Button>
          </Card>
        ) : viewMode === "cards" ? (
          <div className="grid gap-4 lg:grid-cols-2 xl:grid-cols-3">
            {filteredChatboxes.map((chatbox) => (
              <ChatboxSummaryCard
                key={chatbox.chatboxId}
                chatbox={chatbox}
                onOpen={() => onOpenChatbox(chatbox.chatboxId)}
                onEdit={() => onOpenChatbox(chatbox.chatboxId)}
                onUsage={() =>
                  onOpenChatbox(chatbox.chatboxId, {
                    initialViewMode: "usage",
                  })
                }
                onDuplicate={() => onDuplicateChatbox(chatbox)}
                onDelete={() => setPendingDelete(chatbox)}
                isDeleting={deletingChatboxId === chatbox.chatboxId}
                isDuplicating={duplicatingChatboxId === chatbox.chatboxId}
              />
            ))}
          </div>
        ) : (
          <div className="space-y-3">
            {filteredChatboxes.map((chatbox) => (
              <div
                key={chatbox.chatboxId}
                className="flex w-full items-stretch gap-1 rounded-2xl border border-border/70 bg-card/70 transition-colors hover:border-primary/40 hover:bg-card"
              >
                <button
                  type="button"
                  className="flex min-w-0 flex-1 items-center justify-between px-4 py-4 text-left"
                  onClick={() => onOpenChatbox(chatbox.chatboxId)}
                >
                  <div className="min-w-0">
                    <p className="truncate text-sm font-semibold">
                      {chatbox.name}
                    </p>
                    <p className="mt-1 truncate text-sm text-muted-foreground">
                      {chatbox.description || "No description yet."}
                    </p>
                  </div>
                  <div className="ml-4 flex shrink-0 items-center gap-2">
                    <Badge variant="outline">
                      {getChatboxHostStyleShortLabel(chatbox.hostStyle)}
                    </Badge>
                    <Badge variant="outline">
                      {chatbox.serverCount} servers
                    </Badge>
                  </div>
                </button>
                <div className="flex shrink-0 items-center pr-2">
                  <ChatboxIndexRowActionsMenu
                    triggerClassName="text-muted-foreground shrink-0"
                    chatbox={chatbox}
                    onEdit={() => onOpenChatbox(chatbox.chatboxId)}
                    onUsage={() =>
                      onOpenChatbox(chatbox.chatboxId, {
                        initialViewMode: "usage",
                      })
                    }
                    onDuplicate={() => onDuplicateChatbox(chatbox)}
                    onDelete={() => setPendingDelete(chatbox)}
                    isDeleting={deletingChatboxId === chatbox.chatboxId}
                    isDuplicating={duplicatingChatboxId === chatbox.chatboxId}
                  />
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
