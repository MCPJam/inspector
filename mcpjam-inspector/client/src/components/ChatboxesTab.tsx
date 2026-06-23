import { useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router";
import {
  AlertTriangle,
  ExternalLink,
  Inbox,
  Link2,
  Loader2,
} from "lucide-react";
import { useConvexAuth, useMutation } from "convex/react";
import { toast } from "sonner";
import { Button } from "@mcpjam/design-system/button";
import { ViewModeSelector } from "@/components/shared/view-mode-selector";
import { SegmentedControl } from "@/components/ui/json-editor/segmented-control";
import { ChatboxShareSection } from "@/components/chatboxes/ChatboxShareSection";
import { ChatboxUsagePanel } from "@/components/chatboxes/ChatboxUsagePanel";
import { PersonasTab } from "@/components/chatboxes/PersonasTab";
import { ChatboxPublishClientBar } from "@/components/chatboxes/ChatboxPublishClientBar";
import { ChatboxHostCanvasPanel } from "@/components/chatboxes/ChatboxHostCanvasPanel";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable";
import { useChatboxByHostId } from "@/hooks/useChatboxes";
import { useHost } from "@/hooks/useClients";
import { usePreviewedHostId } from "@/hooks/use-previewed-client-id";
import { buildChatboxLink } from "@/lib/chatbox-session";
import { copyToClipboard } from "@/lib/clipboard";
import type { HostConfigMcpProfileV1 } from "@/lib/client-config-v2";
import { previewIframeAllow } from "@/lib/client-preview-iframe-allow";
import { cn } from "@/lib/utils";

/**
 * `/chatboxes` — the publish surface for the currently-selected host's
 * chatbox. Hosts and chatboxes are 1:1, so the global host bar at the top
 * of the app chrome is the navigation control: switching hosts switches
 * the chatbox shown here. Tabs:
 *
 *   - Publish   — link, mode, members, chatUi (`ChatboxShareSection`) on the
 *                 left; the right pane toggles between a live preview of the
 *                 published chatbox and the read-only host graph
 *   - Sessions  — thread list / detail (`ChatboxUsagePanel section="sessions"`)
 *   - Clusters  — topic map / insights (`ChatboxUsagePanel section="insights"`)
 *
 * No "Definition" tab — that belongs to the Host tab inside Connect (agent
 * config). The "Open preview" button here launches the public share link in
 * a new browser tab. Note the embedded preview loads the real share URL, so
 * every visit to this (landing) tab starts a guest session — preview
 * traffic shows up in Sessions and guest analytics.
 */
interface ChatboxesTabProps {
  projectId: string | null;
  isAuthenticated: boolean;
}

type ChatboxTab = "publish" | "personas" | "sessions" | "clusters";

const TAB_OPTIONS: ReadonlyArray<{ value: ChatboxTab; label: string }> = [
  { value: "publish", label: "Publish" },
  { value: "personas", label: "Personas" },
  { value: "sessions", label: "Sessions" },
  { value: "clusters", label: "Clusters" },
];

type PublishPanelView = "preview" | "graph";

const PUBLISH_PANEL_OPTIONS: Array<{ value: PublishPanelView; label: string }> =
  [
    { value: "preview", label: "Preview" },
    { value: "graph", label: "Host graph" },
  ];

export function ChatboxesTab({
  projectId,
  isAuthenticated,
}: ChatboxesTabProps) {
  const [searchParams, setSearchParams] = useSearchParams();
  // Deep link: `/chatboxes?host=<id>&session=<threadId>` (the Sessions tab's
  // "Copy session link"). The params stay in the URL until the user navigates
  // — App's auth/loading gates unmount and remount the route several times
  // during a cold boot, so state captured from the params on first mount
  // doesn't survive to the final mount. The URL itself is the stash: every
  // remount re-seeds tab and thread selection from it.
  const sessionDeepLinkThreadId = searchParams.get("session");
  const [tab, setTab] = useState<ChatboxTab>(() =>
    sessionDeepLinkThreadId ? "sessions" : "publish"
  );
  const [panelView, setPanelView] = useState<PublishPanelView>("preview");
  const [previewedHostId, setPreviewedHostId] = usePreviewedHostId(projectId);
  // Apply the host half of the deep link once the project is known —
  // `setPreviewedHostId` silently no-ops while projectId is null. The host
  // param is dropped immediately after so the host bar can switch hosts
  // without this effect snapping back to the linked one.
  useEffect(() => {
    if (!projectId) return;
    const hostParam = searchParams.get("host");
    if (!hostParam) return;
    if (hostParam !== previewedHostId) {
      setPreviewedHostId(hostParam);
    }
    const next = new URLSearchParams(searchParams);
    next.delete("host");
    setSearchParams(next, { replace: true });
  }, [
    projectId,
    searchParams,
    setSearchParams,
    previewedHostId,
    setPreviewedHostId,
  ]);
  const convexAuth = useConvexAuth();
  const effectiveAuth = isAuthenticated && convexAuth.isAuthenticated;
  const { host } = useHost({
    isAuthenticated: effectiveAuth,
    hostId: previewedHostId,
  });
  const { chatbox, isLoading } = useChatboxByHostId({
    isAuthenticated: effectiveAuth,
    hostId: previewedHostId,
  });

  // Backfill: hosts created before the 1:1 invariant landed don't have an
  // auto-minted chatbox. The first time the user visits this tab for
  // such a host we fire `chatboxes.ensureChatboxForHost` (idempotent on
  // the host's `by_namedHost`), and the reactive query refetches with
  // the new row. Latched per hostId so a transient null + concurrent
  // queries don't trigger duplicate mutations.
  const ensureChatboxForHost = useMutation(
    "chatboxes:ensureChatboxForHost" as any
  );
  const ensureLatchRef = useRef<Set<string>>(new Set());
  // Tracks hostIds where ensure resolved successfully but the reactive
  // query is *still* returning null. That's not provisioning latency —
  // it's the backend silently dropping the chatbox for some reason the
  // query didn't surface. Without this we'd spin forever; with it we
  // render an actionable error instead.
  const [ensureCompletedNullHosts, setEnsureCompletedNullHosts] = useState<
    ReadonlySet<string>
  >(() => new Set());
  useEffect(() => {
    if (!effectiveAuth) return;
    if (!previewedHostId) return;
    if (isLoading) return;
    if (chatbox !== null) return;
    if (ensureLatchRef.current.has(previewedHostId)) return;
    ensureLatchRef.current.add(previewedHostId);
    const targetHostId = previewedHostId;
    let cancelled = false;
    let stuckTimer: ReturnType<typeof setTimeout> | undefined;
    void ensureChatboxForHost({ hostId: targetHostId } as any)
      .then(() => {
        // The mutation returned. Convex's reactive query takes a render or
        // two to refetch and surface the new row, so flipping the "stuck"
        // flag synchronously here flashes the hard-failure UI between
        // resolve and refetch. Wait a short grace window first; if the
        // chatbox still hasn't arrived, mark it stuck. The cleanup hook
        // below clears the flag whenever the chatbox actually appears.
        if (cancelled) return;
        stuckTimer = setTimeout(() => {
          setEnsureCompletedNullHosts((prev) => {
            const next = new Set(prev);
            next.add(targetHostId);
            return next;
          });
        }, 1500);
      })
      .catch((err: unknown) => {
        ensureLatchRef.current.delete(targetHostId);
        toast.error(
          err instanceof Error
            ? err.message
            : "Failed to provision swarm for host"
        );
      });
    return () => {
      cancelled = true;
      if (stuckTimer !== undefined) clearTimeout(stuckTimer);
    };
  }, [
    chatbox,
    effectiveAuth,
    ensureChatboxForHost,
    isLoading,
    previewedHostId,
  ]);
  // Once the chatbox shows up, clear the stuck flag AND the per-host
  // ensure latch so a future drift (host's chatbox gets deleted later in
  // the same session) re-arms the ensure mutation instead of silently
  // dropping it. Keying both cleanups in the same effect keeps them in
  // lockstep with "chatbox is present".
  useEffect(() => {
    if (!previewedHostId) return;
    if (chatbox === null || chatbox === undefined) return;
    ensureLatchRef.current.delete(previewedHostId);
    setEnsureCompletedNullHosts((prev) => {
      if (!prev.has(previewedHostId)) return prev;
      const next = new Set(prev);
      next.delete(previewedHostId);
      return next;
    });
  }, [chatbox, previewedHostId]);

  const publishLink = useMemo(() => {
    if (!chatbox?.link?.token) return null;
    return buildChatboxLink(chatbox.link.token, chatbox.name);
  }, [chatbox]);

  const handleCopyLink = async () => {
    if (!publishLink) return;
    const ok = await copyToClipboard(publishLink);
    if (ok) toast.success("Share link copied");
    else toast.error("Failed to copy share link");
  };

  // Empty state: nothing is selected in the global host bar yet (fresh
  // sign-in, project just switched, etc.). The picker is the navigation
  // control — direct the user there instead of rendering a half-built
  // chatbox detail.
  if (!previewedHostId) {
    return (
      <div className="flex h-full items-center justify-center px-6 text-center">
        <div className="max-w-sm">
          <Inbox className="mx-auto size-8 text-muted-foreground/70" />
          <p className="mt-3 text-sm font-medium">Pick a host</p>
          <p className="mt-1 text-xs text-muted-foreground">
            Use the host bar at the top to choose which host's swarm you want to
            manage.
          </p>
        </div>
      </div>
    );
  }

  if (isLoading) {
    return (
      <div className="flex h-full items-center justify-center text-muted-foreground">
        <Loader2 className="mr-2 size-4 animate-spin" />
        <span className="text-sm">Loading swarm…</span>
      </div>
    );
  }

  if (!chatbox) {
    // If the ensure mutation already returned but the reactive query is
    // *still* null, this is no longer "provisioning latency" — something
    // upstream is making the query drop the row. Render an actionable
    // error so the user isn't staring at a perpetual spinner.
    if (previewedHostId && ensureCompletedNullHosts.has(previewedHostId)) {
      return (
        <ChatboxLoadFailure
          title="Couldn't load this host's swarm"
          body="The backfill mutation succeeded but the chatbox query still returned nothing. Check the Convex logs for getChatboxByHostId on this host."
        />
      );
    }
    // Otherwise: auto-ensure effect above is firing; brief gap between
    // "query says null" and the mutation's reactive refetch.
    return (
      <div className="flex h-full items-center justify-center text-muted-foreground">
        <Loader2 className="mr-2 size-4 animate-spin" />
        <span className="text-sm">Provisioning swarm for this host…</span>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden">
      <div
        className="relative shrink-0 border-b border-border/40 px-8 py-2.5"
        data-testid="chatboxes-tab-header-chrome"
      >
        <div className="flex min-w-0 items-center justify-center">
          <ViewModeSelector
            value={tab}
            ariaLabel="Swarm view"
            onChange={(next) => {
              setTab(next as ChatboxTab);
              // Manual navigation supersedes the deep link — drop the params
              // so returning to Sessions doesn't re-seed the linked thread.
              if (searchParams.size > 0) {
                setSearchParams({}, { replace: true });
              }
            }}
            options={TAB_OPTIONS}
          />
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-hidden">
        {tab === "publish" ? (
          <ResizablePanelGroup direction="horizontal" className="h-full">
            <ResizablePanel defaultSize={50} minSize={32}>
              <div className="h-full overflow-y-auto px-6 py-6">
                <div className="mx-auto flex max-w-3xl flex-col gap-4">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <h2 className="min-w-0 truncate text-lg font-semibold">
                      {chatbox.name}
                    </h2>
                    {publishLink ? (
                      <div className="flex shrink-0 items-center gap-2">
                        <Button
                          variant="outline"
                          size="sm"
                          className="rounded-xl"
                          onClick={() =>
                            window.open(publishLink, "_blank", "noopener")
                          }
                          title="Open the published swarm in a new tab"
                        >
                          <ExternalLink className="mr-1.5 size-4" />
                          Open preview
                        </Button>
                        <Button
                          variant="outline"
                          size="sm"
                          className="rounded-xl"
                          onClick={handleCopyLink}
                        >
                          <Link2 className="mr-1.5 size-4" />
                          Copy link
                        </Button>
                      </div>
                    ) : null}
                  </div>
                  <ChatboxPublishClientBar
                    chatboxId={chatbox.chatboxId}
                    projectId={chatbox.projectId}
                    hostId={chatbox.namedHostId}
                    hostName={host?.name ?? chatbox.namedHostName ?? "Host"}
                    isAuthenticated={effectiveAuth}
                    currentServerIds={chatbox.servers.map((s) => s.serverId)}
                  />
                  <ChatboxShareSection chatbox={chatbox} />
                </div>
              </div>
            </ResizablePanel>
            <ResizableHandle withHandle />
            <ResizablePanel defaultSize={50} minSize={30}>
              <div className="flex h-full min-h-0 flex-col">
                <div className="flex shrink-0 items-center justify-end border-b border-border/40 px-3 py-1.5">
                  <SegmentedControl
                    size="sm"
                    value={panelView}
                    onChange={setPanelView}
                    options={PUBLISH_PANEL_OPTIONS}
                  />
                </div>
                <div className="relative min-h-0 flex-1">
                  {/* Keep the preview iframe mounted (just hidden) while the
                      graph is shown so toggling back doesn't restart the
                      guest session. The graph remounts cheaply, and hidden
                      ReactFlow canvases mis-measure anyway. */}
                  <div
                    className={cn(
                      "absolute inset-0",
                      panelView === "preview" ? "" : "hidden"
                    )}
                  >
                    <ChatboxPreviewPane
                      publishLink={publishLink}
                      mcpProfile={host?.config.mcpProfile}
                    />
                  </div>
                  {panelView === "graph" ? (
                    <div className="absolute inset-0">
                      <ChatboxHostCanvasPanel
                        hostId={chatbox.namedHostId}
                        projectId={chatbox.projectId}
                        isAuthenticated={effectiveAuth}
                      />
                    </div>
                  ) : null}
                </div>
              </div>
            </ResizablePanel>
          </ResizablePanelGroup>
        ) : tab === "personas" ? (
          <PersonasTab chatbox={chatbox} />
        ) : tab === "sessions" ? (
          <ChatboxUsagePanel
            chatbox={chatbox}
            section="sessions"
            initialThreadId={sessionDeepLinkThreadId}
          />
        ) : (
          <ChatboxUsagePanel
            chatbox={chatbox}
            section="insights"
            onOpenSession={(threadId) => {
              // Stash the target in the URL — same shape as the Sessions deep
              // link — so auth-gate remounts re-seed the selection, then flip
              // the tab. The panel instance itself survives the flip and has
              // already updated its own thread selection.
              const next = new URLSearchParams(searchParams);
              next.set("session", threadId);
              setSearchParams(next, { replace: true });
              setTab("sessions");
            }}
          />
        )}
      </div>
    </div>
  );
}

function ChatboxPreviewPane({
  publishLink,
  mcpProfile,
}: {
  publishLink: string | null;
  mcpProfile: HostConfigMcpProfileV1 | undefined;
}) {
  // Render the live published chatbox in an iframe so users can spot-check
  // chrome / welcome surface / tool flow without leaving this tab. We point
  // at the public share URL (same thing "Open preview" opens in a new
  // window) — the chatbox runtime is self-contained and handles auth.
  //
  // Permissions-Policy ratchets at every iframe boundary, so without an
  // `allow=` attribute here the inner mcp-apps renderer's sandbox
  // permissions are pre-blocked by the wrapper and any UI resource that
  // needs clipboard-write / camera / microphone / geolocation renders blank.
  // `previewIframeAllow` derives a strict, spec-only allow list from the
  // host config; the inner mcp-apps renderer remains the per-resource
  // enforcement point. See `lib/host-preview-iframe-allow.ts` for posture.
  const allow = previewIframeAllow(mcpProfile);
  if (!publishLink) {
    return (
      <div className="flex h-full items-center justify-center px-6 text-center">
        <div className="max-w-sm">
          <Inbox className="mx-auto size-8 text-muted-foreground/70" />
          <p className="mt-3 text-sm font-medium">No share link yet</p>
          <p className="mt-1 text-xs text-muted-foreground">
            Publish the swarm to generate a share link, then come back here to
            preview it.
          </p>
        </div>
      </div>
    );
  }
  return (
    <div className="flex h-full min-h-0 flex-col bg-muted/10">
      <iframe
        key={publishLink}
        src={publishLink}
        title="Swarm preview"
        className="size-full flex-1 border-0 bg-background"
        allow={allow}
      />
    </div>
  );
}

function ChatboxLoadFailure({
  title,
  body,
  details,
  detailsLabel,
}: {
  title: string;
  body: string;
  details?: ReadonlyArray<string>;
  detailsLabel?: string;
}) {
  return (
    <div className="flex h-full items-center justify-center px-6 text-center">
      <div className="max-w-md">
        <AlertTriangle className="mx-auto size-8 text-amber-500" />
        <p className="mt-3 text-sm font-medium">{title}</p>
        <p className="mt-1 text-xs text-muted-foreground">{body}</p>
        {details && details.length > 0 ? (
          <div className="mt-3 rounded-md border border-border/40 bg-muted/30 p-2 text-left">
            {detailsLabel ? (
              <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                {detailsLabel}
              </p>
            ) : null}
            <ul className="mt-1 space-y-0.5 font-mono text-[11px] text-foreground">
              {details.map((id) => (
                <li key={id} className="break-all">
                  {id}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </div>
    </div>
  );
}
