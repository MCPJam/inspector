import { useEffect, useState } from "react";
import { useLocation, useNavigate } from "react-router";
import {
  AlertTriangle,
  ArrowLeft,
  ExternalLink,
  Layers,
  Link2,
  Trash2,
} from "lucide-react";
import { Button } from "@mcpjam/design-system/button";
import { CloudRunBadge } from "@/components/computer/CloudRunBadge";
import { ViewModeSelector } from "@/components/shared/view-mode-selector";
import { useComputersEnabled } from "@/hooks/useComputersEnabled";
import { ChatboxShareSection } from "@/components/chatboxes/ChatboxShareSection";
import { ChatboxUsagePanel } from "@/components/chatboxes/ChatboxUsagePanel";
import { ChatboxPreviewPane } from "@/components/chatboxes/ChatboxPreviewPane";
import { ChatboxDeleteConfirmDialog } from "@/components/chatboxes/ChatboxDeleteConfirmDialog";
import {
  useChatboxMutations,
  type ChatboxSettings,
} from "@/hooks/useChatboxes";
import { useHost } from "@/hooks/useClients";
import {
  getChatboxHostLabel,
  getChatboxHostLogo,
} from "@/lib/chatbox-client-style";
import {
  buildUserTestingScenarioPath,
  parseUserTestingDetailTab,
  type UserTestingDetailTab,
} from "@/lib/app-navigation";
import { buildChatboxLink } from "@/lib/chatbox-session";
import { copyToClipboard } from "@/lib/clipboard";
import { toast } from "@/lib/toast";
import { usePreferencesStore } from "@/stores/preferences/preferences-provider";
import { cn } from "@/lib/utils";

/**
 * One User Testing scenario: the share band on top, then what came back from it.
 *
 * Clusters are per-scenario for free — `ChatboxUsagePanel` is chatbox-scoped,
 * so the topic map here only ever covers this scenario's own sessions. There is
 * deliberately no project-wide clusters view: aggregating across scenarios that
 * point at different servers would produce themes nobody can act on.
 *
 * Preview embeds the live share link, which means opening that tab starts a
 * REAL guest session against this scenario — it shows up in Sessions and in
 * guest analytics like any tester's. That's why it mounts lazily (opening a
 * scenario costs nothing) and why the embed tags itself `?surface=preview`
 * (so the session it starts is labelled rather than passing for a tester's).
 */
interface UserTestingScenarioDetailProps {
  chatbox: ChatboxSettings;
  /** Gates the host query behind Preview's iframe permissions. */
  isAuthenticated: boolean;
  onBack: () => void;
  /** Parent returns to the list. */
  onDeleted: () => void;
}

const TAB_OPTIONS: ReadonlyArray<{
  value: UserTestingDetailTab;
  label: string;
}> = [
  { value: "sessions", label: "Sessions" },
  { value: "clusters", label: "Clusters" },
  { value: "preview", label: "Preview" },
];

export function UserTestingScenarioDetail({
  chatbox,
  isAuthenticated,
  onBack,
  onDeleted,
}: UserTestingScenarioDetailProps) {
  const navigate = useNavigate();
  const location = useLocation();
  const computersEnabled = useComputersEnabled();
  const themeMode = usePreferencesStore((s) => s.themeMode);
  const { deleteChatbox } = useChatboxMutations();
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);

  // The URL is the stash for both the tab and the opened session: the gates
  // above remount this route during a cold boot, so state captured on first
  // mount wouldn't survive to the last one.
  const tab = parseUserTestingDetailTab(location.search);
  const sessionDeepLinkThreadId = new URLSearchParams(location.search).get(
    "session",
  );

  const environmentName = chatbox.environmentName ?? null;
  // Present only when the environment can't resolve right now (archived, a
  // pinned plugin disabled, its host gone). The scenario still opens: its
  // sessions are history worth reading, and unpublishing it is the action
  // this state calls for.
  const environmentError = chatbox.environmentError ?? null;

  const publishLink = chatbox.link?.token
    ? buildChatboxLink(chatbox.link.token, chatbox.name)
    : null;
  const displayLink = publishLink?.replace(/^https?:\/\//, "") ?? null;

  // Preview embeds the live share link, so it starts a real guest session.
  // Mount it only once the tab has been opened — and then keep it mounted
  // (hidden) so flipping back to Sessions and returning doesn't start a
  // second one. A deep link straight to `?tab=preview` opens it immediately.
  const [hasOpenedPreview, setHasOpenedPreview] = useState(tab === "preview");
  useEffect(() => {
    if (tab === "preview") setHasOpenedPreview(true);
  }, [tab]);

  // The host config decides which browser features the preview iframe may
  // pass through to the mcp-apps renderer inside it. The `allow` attribute
  // only takes effect at mount, and its no-config default is permissive, so
  // a deny-all host would get the wrong frame if we mounted before this
  // resolved. `useHost` reports a SKIPPED query as loading forever — treat it
  // as pending only when it can actually resolve.
  const previewHostId = chatbox.namedHostId ?? null;
  const { host: previewHost, isLoading: previewHostLoading } = useHost({
    isAuthenticated,
    hostId: previewHostId,
  });
  const isPreviewProfilePending =
    isAuthenticated && Boolean(previewHostId) && previewHostLoading;

  const goToTab = (next: UserTestingDetailTab) => {
    // Replace, not push: flipping a sub-tab shouldn't put a stop on the back
    // button between the scenario and the list. Drops `?session=` — that
    // selection belongs to the Sessions tab.
    navigate(buildUserTestingScenarioPath(chatbox.chatboxId, { tab: next }), {
      replace: true,
    });
  };

  const handleCopyLink = async () => {
    if (!publishLink) return;
    const ok = await copyToClipboard(publishLink);
    if (ok) toast.success("Share link copied");
    else toast.error("Failed to copy share link");
  };

  const handleDelete = async () => {
    setIsDeleting(true);
    try {
      await deleteChatbox({ chatboxId: chatbox.chatboxId } as any);
      toast.success("Scenario deleted");
      setDeleteOpen(false);
      onDeleted();
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "Failed to delete the scenario",
      );
      // Rethrow: the dialog closes itself when `onConfirm` RESOLVES, so
      // swallowing here would dismiss the confirmation on a delete that
      // didn't happen and leave the user believing it did.
      throw err;
    } finally {
      setIsDeleting(false);
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden">
      <div className="shrink-0 border-b border-border/40 px-6 py-4 sm:px-8">
        <button
          type="button"
          onClick={onBack}
          data-testid="user-testing-detail-back"
          className={cn(
            "inline-flex items-center gap-1 rounded-sm text-sm font-medium text-primary",
            "hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
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
              {environmentName ? (
                // Environment-backed: the environment IS the scenario's
                // identity. Its client is a detail of the environment, not a
                // second name for the thing.
                <>
                  <Layers className="size-4 shrink-0" />
                  <span className="truncate font-medium text-foreground">
                    {environmentName}
                  </span>
                </>
              ) : (
                <>
                  <span className="inline-flex size-5 items-center justify-center overflow-hidden rounded-sm border border-border/50 bg-background">
                    <img
                      src={getChatboxHostLogo(
                        chatbox.hostStyle,
                        undefined,
                        themeMode,
                      )}
                      alt=""
                      className="size-3.5 object-contain"
                    />
                  </span>
                  <span className="font-medium text-foreground">
                    {getChatboxHostLabel(chatbox.hostStyle)}
                  </span>
                  <span aria-hidden="true" className="text-muted-foreground/40">
                    ·
                  </span>
                  <span className="truncate">{chatbox.namedHostName}</span>
                </>
              )}
              {computersEnabled ? (
                <CloudRunBadge
                  tooltip="Tester computer commands run in per-conversation MCPJam cloud sandboxes — never on the machine serving this inspector."
                  data-testid="user-testing-cloud-run-badge"
                />
              ) : null}
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {publishLink ? (
              <Button
                variant="outline"
                size="sm"
                onClick={() => window.open(publishLink, "_blank", "noopener")}
              >
                <ExternalLink className="mr-1.5 size-4" />
                Open
              </Button>
            ) : null}
            <Button
              variant="outline"
              size="sm"
              onClick={() => setDeleteOpen(true)}
            >
              <Trash2 className="mr-1.5 size-4" />
              Delete
            </Button>
          </div>
        </div>

        {environmentError ? (
          <div
            data-testid="user-testing-detail-environment-error"
            className="mt-4 flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 px-4 py-3"
          >
            <AlertTriangle className="mt-0.5 size-4 shrink-0 text-amber-600 dark:text-amber-500" />
            <div className="min-w-0 text-sm">
              <p className="font-medium text-foreground">
                {environmentError.code === "ENV_ARCHIVED"
                  ? "This scenario's environment is archived — the share link no longer opens."
                  : "This scenario's environment can't be loaded right now — the share link won't open."}
              </p>
              <p className="mt-0.5 text-xs text-muted-foreground">
                {environmentError.message} Its sessions below are unaffected.
              </p>
            </div>
          </div>
        ) : null}

        <div className="mt-4 flex flex-col gap-3 rounded-md border border-primary/20 bg-primary/5 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="min-w-0">
            <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
              Share this with testers
            </p>
            {displayLink ? (
              <p className="mt-1 truncate text-base font-semibold text-foreground">
                {displayLink}
              </p>
            ) : (
              <p className="mt-1 text-sm text-muted-foreground">
                No share link yet.
              </p>
            )}
          </div>
          <Button
            size="sm"
            disabled={!publishLink}
            onClick={() => void handleCopyLink()}
          >
            <Link2 className="mr-1.5 size-4" />
            Copy link
          </Button>
        </div>

        <div className="mt-4">
          <ChatboxShareSection chatbox={chatbox} />
        </div>

        <nav className="mt-5">
          <ViewModeSelector
            value={tab}
            options={TAB_OPTIONS}
            onChange={goToTab}
            ariaLabel="Scenario view"
            indicatorId="user-testing-detail"
          />
        </nav>
      </div>

      <div className="relative min-h-0 flex-1 overflow-hidden">
        {tab === "sessions" ? (
          <div className="absolute inset-0">
            <ChatboxUsagePanel
              chatbox={chatbox}
              section="sessions"
              initialThreadId={sessionDeepLinkThreadId}
            />
          </div>
        ) : null}
        {tab === "clusters" ? (
          <div className="absolute inset-0">
            <ChatboxUsagePanel
              chatbox={chatbox}
              section="insights"
              onOpenSession={(threadId) => {
                // Stash the target in the URL, then flip the tab — the same
                // reason the tab itself lives there.
                navigate(
                  buildUserTestingScenarioPath(chatbox.chatboxId, {
                    session: threadId,
                  }),
                  { replace: true },
                );
              }}
            />
          </div>
        ) : null}
        {hasOpenedPreview ? (
          // Hidden rather than unmounted: re-mounting would abandon the
          // tester session already running in the frame and start another.
          <div
            className={cn("absolute inset-0", tab === "preview" ? "" : "hidden")}
          >
            {isPreviewProfilePending ? (
              <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
                Loading preview…
              </div>
            ) : (
              <ChatboxPreviewPane
                publishLink={environmentError ? null : publishLink}
                mcpProfile={previewHost?.config.mcpProfile}
                emptyTitle={
                  environmentError
                    ? "This scenario can't be previewed"
                    : undefined
                }
                emptyBody={
                  environmentError
                    ? `${environmentError.message} Its sessions are unaffected.`
                    : undefined
                }
              />
            )}
          </div>
        ) : null}
      </div>

      <ChatboxDeleteConfirmDialog
        entityLabel="scenario"
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        chatboxName={chatbox.name}
        isDeleting={isDeleting}
        onConfirm={handleDelete}
      />
    </div>
  );
}
