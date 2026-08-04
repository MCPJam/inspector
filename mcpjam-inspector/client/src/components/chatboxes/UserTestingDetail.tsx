import { useState } from "react";
import { ArrowLeft, ExternalLink, Link2 } from "lucide-react";
import { Button } from "@mcpjam/design-system/button";
import type { ChatboxSettings } from "@/hooks/useChatboxes";
import type { SharedChatThread } from "@/hooks/useSharedChatThreads";
import { ChatboxUsagePanel } from "@/components/chatboxes/ChatboxUsagePanel";
import { ShareChatboxDialog } from "@/components/chatboxes/ShareChatboxDialog";
import {
  getChatboxHostLabel,
  getChatboxHostLogo,
} from "@/lib/chatbox-client-style";
import { buildChatboxLink } from "@/lib/chatbox-session";
import { copyToClipboard } from "@/lib/clipboard";
import { toast } from "@/lib/toast";
import { usePreferencesStore } from "@/stores/preferences/preferences-provider";
import { cn } from "@/lib/utils";

interface UserTestingDetailProps {
  chatbox: ChatboxSettings;
  initialThreadId?: string | null;
  onBack: () => void;
  onOpenSession?: (threadId: string) => void;
  /** Fixture threads for demo QA. */
  demoThreads?: SharedChatThread[];
  isDemo?: boolean;
}

export function UserTestingDetail({
  chatbox,
  initialThreadId,
  onBack,
  onOpenSession,
  demoThreads,
  isDemo = false,
}: UserTestingDetailProps) {
  const themeMode = usePreferencesStore((s) => s.themeMode);
  const [shareOpen, setShareOpen] = useState(false);
  const publishLink = isDemo
    ? chatbox.link?.url ?? null
    : chatbox.link?.token
      ? buildChatboxLink(chatbox.link.token, chatbox.name)
      : null;
  const displayLink = publishLink
    ? publishLink.replace(/^https?:\/\//, "")
    : null;
  const clientLabel = getChatboxHostLabel(chatbox.hostStyle);
  const clientLogo = getChatboxHostLogo(
    chatbox.hostStyle,
    undefined,
    themeMode,
  );

  const handleCopyLink = async () => {
    if (!publishLink) return;
    const ok = await copyToClipboard(publishLink);
    if (ok) toast.success("Share link copied");
    else toast.error("Failed to copy share link");
  };

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden">
      <div className="shrink-0 border-b border-border/40 px-6 py-4 sm:px-8">
        <button
          type="button"
          onClick={onBack}
          className={cn(
            "inline-flex items-center gap-1 text-sm font-medium text-primary",
            "hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-sm",
          )}
        >
          <ArrowLeft className="size-3.5" />
          User Testing
        </button>
        <div className="mt-2 flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h1 className="truncate text-xl font-semibold tracking-tight">
              {chatbox.name}
            </h1>
            <div className="mt-1.5 flex items-center gap-2 text-sm text-muted-foreground">
              <span>Client:</span>
              <span className="inline-flex size-5 items-center justify-center overflow-hidden rounded-sm border border-border/50 bg-background">
                <img
                  src={clientLogo}
                  alt=""
                  className="size-3.5 object-contain"
                />
              </span>
              <span className="font-medium text-foreground">{clientLabel}</span>
            </div>
          </div>
          {publishLink ? (
            <Button
              variant="outline"
              size="sm"
              onClick={() => window.open(publishLink, "_blank", "noopener")}
            >
              <ExternalLink className="mr-1.5 size-4" />
              Open preview
            </Button>
          ) : null}
        </div>

        <div className="mt-4 flex flex-col gap-3 rounded-md border border-primary/20 bg-primary/5 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="min-w-0">
            <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
              Share this with customers
            </p>
            {displayLink ? (
              <p className="mt-1 truncate text-base font-semibold text-foreground">
                {displayLink}
              </p>
            ) : (
              <p className="mt-1 text-sm text-muted-foreground">
                No share link yet — invite or open access settings to publish.
              </p>
            )}
            <p className="mt-0.5 text-xs text-muted-foreground">
              They open it in the selected client and work through tasks against
              your live server.
            </p>
          </div>
          <div className="flex shrink-0 flex-wrap gap-2">
            <Button
              variant="outline"
              size="sm"
              className="bg-background"
              onClick={() => setShareOpen(true)}
            >
              Invite by email
            </Button>
            <Button
              size="sm"
              disabled={!publishLink}
              onClick={() => void handleCopyLink()}
            >
              <Link2 className="mr-1.5 size-4" />
              Copy link
            </Button>
          </div>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-hidden px-2 pb-2 sm:px-4">
        <ChatboxUsagePanel
          chatbox={chatbox}
          section="sessions"
          initialThreadId={initialThreadId}
          onOpenSession={onOpenSession}
          threadsOverride={demoThreads}
        />
      </div>

      <ShareChatboxDialog
        isOpen={shareOpen}
        onClose={() => setShareOpen(false)}
        chatbox={chatbox}
        previewMode={isDemo}
      />
    </div>
  );
}
