import { useState } from "react";
import { ChevronDown, Copy, ExternalLink, Globe, Loader2 } from "lucide-react";
import { toast } from "@/lib/toast";
import { Button } from "@mcpjam/design-system/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@mcpjam/design-system/dropdown-menu";
import { convexErrMessage } from "@/lib/convex-error";
import { useChatboxMutations } from "@/hooks/useChatboxes";
import {
  chatboxAccessPresetFromSettings,
  settingsFromChatboxAccessPreset,
  type ChatboxAccessPreset,
} from "@/lib/chatbox-access-presets";
import {
  useEnvironmentChatbox,
  usePublishEnvironmentChatbox,
  useUnpublishEnvironmentChatbox,
} from "@/hooks/useProjectEnvironments";

const ACCESS_PRESET_LABELS: Record<ChatboxAccessPreset, string> = {
  project: "Project members",
  invited_only: "Invited only",
  link_guests: "Anyone with the link",
};

/**
 * Publish-as-chatbox panel for one environment (Phase 5, live-follow).
 *
 * The published chatbox is a POINTER to the environment: edits reflect
 * immediately on the share link, so unlike ChatboxesTab there is no
 * republish/snapshot affordance here — just publish, access mode, copy link,
 * and unpublish. Invited-member management stays on the chatbox surfaces;
 * this panel deliberately does not fork ChatboxShareSection (which needs the
 * full members-carrying `ChatboxSettings`).
 */
export function EnvironmentChatboxSection({
  projectId,
  environmentId,
  environmentName,
  canManage,
}: {
  projectId: string;
  environmentId: string;
  environmentName: string;
  canManage: boolean;
}) {
  const chatbox = useEnvironmentChatbox(projectId, environmentId);
  const publishChatbox = usePublishEnvironmentChatbox();
  const unpublishChatbox = useUnpublishEnvironmentChatbox();
  const { setChatboxMode } = useChatboxMutations();
  const [busy, setBusy] = useState(false);
  const [confirmingUnpublish, setConfirmingUnpublish] = useState(false);

  if (chatbox === undefined) {
    return null;
  }

  const onPublish = async () => {
    setBusy(true);
    try {
      await publishChatbox({ environmentId });
      toast.success(`Published “${environmentName}” as a chatbox.`);
    } catch (err) {
      toast.error(convexErrMessage(err, "Could not publish the chatbox."));
    } finally {
      setBusy(false);
    }
  };

  const onUnpublish = async () => {
    setBusy(true);
    try {
      await unpublishChatbox({ environmentId });
      toast.success("Chatbox unpublished. The share link no longer works.");
      setConfirmingUnpublish(false);
    } catch (err) {
      toast.error(convexErrMessage(err, "Could not unpublish the chatbox."));
    } finally {
      setBusy(false);
    }
  };

  const onAccessPresetChange = async (preset: ChatboxAccessPreset) => {
    if (!chatbox) return;
    const current = chatboxAccessPresetFromSettings(
      chatbox.mode,
      chatbox.allowGuestAccess
    );
    if (preset === current) return;
    const target = settingsFromChatboxAccessPreset(preset);
    setBusy(true);
    try {
      await setChatboxMode({ chatboxId: chatbox.chatboxId, mode: target.mode });
    } catch (err) {
      toast.error(convexErrMessage(err, "Could not update chatbox access."));
    } finally {
      setBusy(false);
    }
  };

  const onCopyLink = async (url: string) => {
    try {
      await navigator.clipboard.writeText(url);
      toast.success("Link copied.");
    } catch {
      toast.error("Could not copy the link.");
    }
  };

  if (!chatbox) {
    if (!canManage) return null;
    return (
      <div className="flex items-center justify-between gap-3 rounded-md border p-3">
        <div>
          <p className="text-sm font-medium text-foreground">Chatbox</p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Publish this environment as a shareable chat. The link always runs
            the environment as currently configured — edits apply immediately.
          </p>
        </div>
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="shrink-0"
          disabled={busy}
          onClick={() => void onPublish()}
          data-testid="environment-chatbox-publish"
        >
          {busy ? <Loader2 className="mr-1.5 size-3.5 animate-spin" /> : null}
          Publish as chatbox
        </Button>
      </div>
    );
  }

  const accessPreset = chatboxAccessPresetFromSettings(
    chatbox.mode,
    chatbox.allowGuestAccess
  );

  return (
    <div className="space-y-3 rounded-md border p-3">
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <Globe className="size-4 shrink-0 text-muted-foreground" />
          <div className="min-w-0">
            <p className="text-sm font-medium text-foreground">
              Published as chatbox
            </p>
            <p className="mt-0.5 text-xs text-muted-foreground">
              Live-follow: the link runs the environment as currently
              configured. Archiving the environment makes the link fail.
            </p>
          </div>
        </div>
        {canManage ? (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="h-7 shrink-0 text-xs"
                disabled={busy}
                data-testid="environment-chatbox-access"
              >
                {ACCESS_PRESET_LABELS[accessPreset]}
                <ChevronDown className="ml-1 size-3" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuRadioGroup
                value={accessPreset}
                onValueChange={(value) =>
                  void onAccessPresetChange(value as ChatboxAccessPreset)
                }
              >
                {(
                  Object.keys(ACCESS_PRESET_LABELS) as ChatboxAccessPreset[]
                ).map((preset) => (
                  <DropdownMenuRadioItem key={preset} value={preset}>
                    {ACCESS_PRESET_LABELS[preset]}
                  </DropdownMenuRadioItem>
                ))}
              </DropdownMenuRadioGroup>
            </DropdownMenuContent>
          </DropdownMenu>
        ) : null}
      </div>

      {chatbox.link ? (
        <div className="flex items-center gap-2">
          <code
            className="min-w-0 flex-1 truncate rounded bg-muted/50 px-2 py-1.5 font-mono text-[11px] text-muted-foreground"
            data-testid="environment-chatbox-link"
          >
            {chatbox.link.url}
          </code>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="h-7 shrink-0 px-2 text-xs"
            onClick={() => void onCopyLink(chatbox.link!.url)}
          >
            <Copy className="mr-1 size-3" /> Copy
          </Button>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="h-7 shrink-0 px-2 text-xs"
            asChild
          >
            <a
              href={chatbox.link.url}
              target="_blank"
              rel="noreferrer noopener"
            >
              <ExternalLink className="mr-1 size-3" /> Open
            </a>
          </Button>
        </div>
      ) : null}

      {canManage ? (
        <div className="flex items-center justify-end gap-2 text-xs">
          {confirmingUnpublish ? (
            <>
              <span className="text-muted-foreground">
                Unpublish? The share link stops working; the environment is
                untouched.
              </span>
              <Button
                type="button"
                size="sm"
                variant="destructive"
                className="h-7 text-xs"
                disabled={busy}
                onClick={() => void onUnpublish()}
                data-testid="environment-chatbox-unpublish-confirm"
              >
                {busy ? (
                  <Loader2 className="mr-1.5 size-3.5 animate-spin" />
                ) : null}
                Unpublish
              </Button>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                className="h-7 text-xs"
                disabled={busy}
                onClick={() => setConfirmingUnpublish(false)}
              >
                Cancel
              </Button>
            </>
          ) : (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="h-7 text-xs text-destructive hover:text-destructive"
              onClick={() => setConfirmingUnpublish(true)}
              data-testid="environment-chatbox-unpublish"
            >
              Unpublish
            </Button>
          )}
        </div>
      ) : null}
    </div>
  );
}
