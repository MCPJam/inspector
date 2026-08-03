/**
 * Publish-as-chatbox section for an environment's detail view.
 *
 * Env-backed chatboxes are POINTER rows (Phase 5, mcpjam-backend #805): no
 * hostConfig pin, no chatbox-scope server attachment — runtime resolution
 * re-resolves the environment fresh on every read, so editing the environment
 * updates the published chatbox immediately. They are deliberately invisible
 * to the host-first ChatboxesTab (`getHostPublishChatbox` filters them out),
 * which makes THIS the management surface: publish, copy the share link, and
 * unpublish. One chatbox per environment, backend-enforced.
 *
 * Full admin parity with host-backed chatboxes: once published, the standard
 * `ChatboxShareSection` (access mode, member invites, guest execution) renders
 * here against the row's full `getChatbox` settings — the backend's row-level
 * editors (`setChatboxMode`, `upsertChatboxMember`, `setChatboxGuestExecution`)
 * are not env-guarded; only server editing is (the environment owns the server
 * set, so there is deliberately no server picker). Publish/unpublish are
 * project-ADMIN gated backend-side; the backend's FORBIDDEN/CONFLICT copy is
 * surfaced verbatim.
 */
import { useState } from "react";
import { useConvexAuth } from "convex/react";
import { Copy, ExternalLink, Loader2, MessageSquare } from "lucide-react";
import { Button } from "@mcpjam/design-system/button";
import { toast } from "@/lib/toast";
import { convexErrMessage } from "@/lib/convex-error";
import { copyToClipboard } from "@/lib/clipboard";
import { buildChatboxLink } from "@/lib/chatbox-session";
import {
  useChatbox,
  useEnvironmentChatbox,
  useEnvironmentChatboxMutations,
} from "@/hooks/useChatboxes";
import { ChatboxShareSection } from "@/components/chatboxes/ChatboxShareSection";
import type { ProjectEnvironmentView } from "@/hooks/useProjectEnvironments";

export function EnvironmentChatboxSection({
  projectId,
  environment,
  canManage,
}: {
  projectId: string;
  environment: ProjectEnvironmentView;
  /** Publish/unpublish are admin-gated; members see state read-only. */
  canManage: boolean;
}) {
  const { isAuthenticated } = useConvexAuth();
  const { chatbox } = useEnvironmentChatbox({
    isAuthenticated,
    projectId,
    environmentId: environment.environmentId,
  });
  const { publishEnvironmentChatbox, unpublishEnvironmentChatbox } =
    useEnvironmentChatboxMutations();
  // Full settings for the published row — powers the standard share/access
  // editors below. Null/undefined until published (the list row above only
  // carries the summary projection).
  const { chatbox: chatboxSettings } = useChatbox({
    isAuthenticated,
    chatboxId: chatbox?.chatboxId ?? null,
  });
  const [busy, setBusy] = useState(false);
  const [confirmingUnpublish, setConfirmingUnpublish] = useState(false);

  const link = chatbox?.link?.token
    ? buildChatboxLink(chatbox.link.token, chatbox.name)
    : null;

  const onPublish = async () => {
    setBusy(true);
    try {
      const result = await publishEnvironmentChatbox({
        environmentId: environment.environmentId,
      });
      toast.success(
        result.created
          ? `Published “${environment.name}” as a chatbox.`
          : `“${environment.name}” is already published.`
      );
    } catch (err) {
      toast.error(convexErrMessage(err, "Could not publish the chatbox."));
    } finally {
      setBusy(false);
    }
  };

  const onUnpublish = async () => {
    setBusy(true);
    try {
      await unpublishEnvironmentChatbox({
        environmentId: environment.environmentId,
      });
      toast.success(`Unpublished “${environment.name}”'s chatbox.`);
      setConfirmingUnpublish(false);
    } catch (err) {
      toast.error(convexErrMessage(err, "Could not unpublish the chatbox."));
    } finally {
      setBusy(false);
    }
  };

  const onCopyLink = async () => {
    if (!link) return;
    const ok = await copyToClipboard(link);
    if (ok) toast.success("Share link copied");
    else toast.error("Failed to copy share link");
  };

  return (
    <section className="rounded-md border p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <h3 className="flex items-center gap-1.5 text-xs font-medium">
            <MessageSquare className="size-3.5" /> Chatbox
          </h3>
          <p className="mt-0.5 text-[11px] leading-snug text-muted-foreground">
            {chatbox
              ? "Published — the chatbox live-follows this environment; edits here apply to it immediately."
              : "Publish this environment as a shareable chatbox. It live-follows the environment — no separate config to keep in sync."}
          </p>
        </div>

        {chatbox === undefined ? (
          <Loader2 className="size-3.5 animate-spin text-muted-foreground" />
        ) : chatbox === null ? (
          canManage ? (
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="h-7 shrink-0 text-xs"
              disabled={busy}
              data-testid="environment-chatbox-publish"
              onClick={() => void onPublish()}
            >
              {busy ? (
                <Loader2 className="mr-1.5 size-3.5 animate-spin" />
              ) : null}
              Publish as chatbox
            </Button>
          ) : (
            <span className="text-[11px] text-muted-foreground">
              Not published
            </span>
          )
        ) : (
          <span className="flex shrink-0 flex-wrap items-center gap-1.5">
            {link ? (
              <>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  className="h-7 text-xs"
                  data-testid="environment-chatbox-copy-link"
                  onClick={() => void onCopyLink()}
                >
                  <Copy className="mr-1.5 size-3.5" /> Copy link
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  className="h-7 text-xs"
                  onClick={() => window.open(link, "_blank", "noopener")}
                >
                  <ExternalLink className="mr-1.5 size-3.5" /> Open
                </Button>
              </>
            ) : null}
            {canManage ? (
              confirmingUnpublish ? (
                <>
                  <Button
                    type="button"
                    size="sm"
                    variant="destructive"
                    className="h-7 text-xs"
                    disabled={busy}
                    data-testid="environment-chatbox-unpublish-confirm"
                    onClick={() => void onUnpublish()}
                  >
                    {busy ? (
                      <Loader2 className="mr-1.5 size-3.5 animate-spin" />
                    ) : null}
                    Unpublish — link stops working
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
                  data-testid="environment-chatbox-unpublish"
                  onClick={() => setConfirmingUnpublish(true)}
                >
                  Unpublish
                </Button>
              )
            ) : null}
          </span>
        )}
      </div>

      {/* Full sharing & access controls — the SAME component host-backed
          chatboxes use (mode, member invites, guest execution). Rendered only
          for admins: every mutation inside is admin/owner-gated backend-side,
          and read-only members already get the state line above. */}
      {chatbox && canManage && chatboxSettings ? (
        <div
          className="mt-3 border-t pt-3"
          data-testid="environment-chatbox-share-section"
        >
          <ChatboxShareSection chatbox={chatboxSettings} />
        </div>
      ) : null}
    </section>
  );
}
