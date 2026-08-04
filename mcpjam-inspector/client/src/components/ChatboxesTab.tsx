import { useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate, useSearchParams } from "react-router";
import {
  AlertTriangle,
  Boxes,
  Inbox,
  Loader2,
  Network,
  Plus,
} from "lucide-react";
import { useConvexAuth, useMutation } from "convex/react";
import { toast } from "@/lib/toast";
import { Button } from "@mcpjam/design-system/button";
import { ChatboxUsagePanel } from "@/components/chatboxes/ChatboxUsagePanel";
import { UserTestingOverview } from "@/components/chatboxes/UserTestingOverview";
import { UserTestingDetail } from "@/components/chatboxes/UserTestingDetail";
import { UserTestingDesign } from "@/components/chatboxes/UserTestingDesign";
import {
  USER_TESTING_DEMO_ROWS,
  USER_TESTING_DEMO_TESTER_COUNTS,
  USER_TESTING_DEMO_THREADS,
  buildUserTestingDemoChatbox,
  isUserTestingDemoHostId,
} from "@/components/chatboxes/user-testing-demo";
import {
  useChatboxByHostId,
  useChatboxList,
  useChatboxMutations,
} from "@/hooks/useChatboxes";
import { useHost, useHostList } from "@/hooks/useClients";
import { useUsageInsights } from "@/hooks/useUsageInsights";
import { EMPTY_USAGE_FILTER } from "@/hooks/chatbox-usage-filters";
import { usePreviewedHostId } from "@/hooks/use-previewed-client-id";
import { routePaths } from "@/lib/app-navigation";
import { cn } from "@/lib/utils";
import { useSurfaceAgentBridge } from "@/lib/webmcp/use-surface-agent-bridge";
import { createInspectorCommandClientError } from "@/lib/inspector-command-handlers";
import type {
  DeleteChatboxInspectorCommand,
  PublishChatboxInspectorCommand,
} from "@/shared/inspector-command.js";

/**
 * `/user-testing` — User Testing (formerly Chatbox). Hosts and chatboxes
 * remain 1:1 under the hood. Views:
 *
 *   - Overview          — list of tests + Create new test
 *   - Feedback Clusters — existing topic map (rename only)
 *   - Detail            — `?host=` share band + sessions
 *   - Design            — `/user-testing/new` create flow
 */
interface ChatboxesTabProps {
  projectId: string | null;
  isAuthenticated: boolean;
}

type TopTab = "overview" | "clusters";

const TOP_TAB_OPTIONS: ReadonlyArray<{ value: TopTab; label: string }> = [
  { value: "overview", label: "Overview" },
  { value: "clusters", label: "Feedback Clusters" },
];

export function ChatboxesTab({
  projectId,
  isAuthenticated,
}: ChatboxesTabProps) {
  const location = useLocation();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const sessionDeepLinkThreadId = searchParams.get("session");
  const hostFromUrl = searchParams.get("host");
  const isDesignPath =
    location.pathname === `${routePaths.userTesting}/new` ||
    location.pathname.endsWith("/user-testing/new");

  const [topTab, setTopTab] = useState<TopTab>("overview");
  const [previewedHostId, setPreviewedHostId] = usePreviewedHostId(projectId);
  // Prefer URL host for detail; keep previewed host in sync for ensure + agent.
  const detailHostId = hostFromUrl ?? null;

  useEffect(() => {
    if (!projectId || !hostFromUrl) return;
    if (hostFromUrl !== previewedHostId) {
      setPreviewedHostId(hostFromUrl);
    }
  }, [projectId, hostFromUrl, previewedHostId, setPreviewedHostId]);

  const convexAuth = useConvexAuth();
  const effectiveAuth = isAuthenticated && convexAuth.isAuthenticated;

  const activeHostId = detailHostId ?? previewedHostId;
  const { host, isLoading: hostLoading } = useHost({
    isAuthenticated: effectiveAuth,
    hostId: activeHostId,
  });
  const isJourneysHost = host?.ownerScope?.type === "journeys";
  const { chatbox, isLoading } = useChatboxByHostId({
    isAuthenticated: effectiveAuth,
    hostId: activeHostId,
  });

  const { chatboxes: listChatboxes, isLoading: listLoading } = useChatboxList({
    isAuthenticated: effectiveAuth,
    projectId,
  });

  // Filter journeys-owned hosts out of Overview when we can resolve owner
  // from the host list.
  const { hosts: projectHosts } = useHostList({
    isAuthenticated: effectiveAuth,
    projectId,
  });
  const overviewRows = useMemo(() => {
    const journeysHostIds = new Set(
      (projectHosts ?? [])
        .filter((h) => h.ownerScope?.type === "journeys")
        .map((h) => h.hostId),
    );
    return (listChatboxes ?? []).filter(
      (c) => !journeysHostIds.has(c.namedHostId),
    );
  }, [listChatboxes, projectHosts]);

  const ensureChatboxForHost = useMutation(
    "chatboxes:ensureChatboxForHost" as any,
  );
  const ensureLatchRef = useRef<Set<string>>(new Set());
  const suppressEnsureHostsRef = useRef<Set<string>>(new Set());
  const [ensureCompletedNullHosts, setEnsureCompletedNullHosts] = useState<
    ReadonlySet<string>
  >(() => new Set());

  // Backfill only while viewing a specific test detail (URL host).
  useEffect(() => {
    if (!effectiveAuth) return;
    if (!detailHostId) return;
    if (isLoading || hostLoading) return;
    if (!host) return;
    if (isJourneysHost) return;
    if (chatbox !== null) return;
    if (suppressEnsureHostsRef.current.has(detailHostId)) return;
    if (ensureLatchRef.current.has(detailHostId)) return;
    ensureLatchRef.current.add(detailHostId);
    const targetHostId = detailHostId;
    let cancelled = false;
    let stuckTimer: ReturnType<typeof setTimeout> | undefined;
    void ensureChatboxForHost({ hostId: targetHostId } as any)
      .then(() => {
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
            : "Failed to provision test for this client",
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
    host,
    hostLoading,
    isJourneysHost,
    detailHostId,
  ]);

  useEffect(() => {
    if (!detailHostId) return;
    if (chatbox === null || chatbox === undefined) return;
    ensureLatchRef.current.delete(detailHostId);
    suppressEnsureHostsRef.current.delete(detailHostId);
    setEnsureCompletedNullHosts((prev) => {
      if (!prev.has(detailHostId)) return prev;
      const next = new Set(prev);
      next.delete(detailHostId);
      return next;
    });
  }, [chatbox, detailHostId]);

  const openTest = (hostId: string) => {
    setPreviewedHostId(hostId);
    const next = new URLSearchParams();
    next.set("host", hostId);
    navigate(`${routePaths.userTesting}?${next.toString()}`);
  };

  const goOverview = () => {
    setTopTab("overview");
    navigate(routePaths.userTesting);
  };

  const goCreate = () => {
    navigate(`${routePaths.userTesting}/new`);
  };

  // --- Agent tool group (surface "chatboxes") ---------------------------
  const AGENT_SNAPSHOT_MAX_SESSIONS = 30;
  const agentOperable = effectiveAuth && Boolean(projectId);
  const { hosts: agentHosts } = useHostList({
    isAuthenticated: effectiveAuth,
    projectId,
  });
  const { chatboxes: agentChatboxes } = useChatboxList({
    isAuthenticated: effectiveAuth,
    projectId,
  });
  const { deleteChatbox } = useChatboxMutations();
  const { threads: agentSessionThreads } = useUsageInsights({
    sourceType: "chatbox",
    sourceId: chatbox?.chatboxId ?? null,
    filters: EMPTY_USAGE_FILTER,
    enabled: agentOperable && Boolean(chatbox?.chatboxId),
  });

  const requireAgentOperable = () => {
    if (!agentOperable) {
      throw createInspectorCommandClientError(
        "unsupported_in_mode",
        "The User Testing tools are locked here — sign in and select a project first.",
      );
    }
  };

  const resolveAgentHost = (raw: unknown) => {
    if (typeof raw !== "string" || raw.trim().length === 0) {
      throw createInspectorCommandClientError(
        "invalid_request",
        "Missing required 'host' string (a client name or id).",
      );
    }
    const wanted = raw.trim();
    const wantedLower = wanted.toLowerCase();
    const matches = agentHosts.filter(
      (h) => h.hostId === wanted || h.name.toLowerCase() === wantedLower,
    );
    if (matches.length === 1) return matches[0];
    if (matches.length === 0) {
      throw createInspectorCommandClientError(
        "invalid_request",
        `No client matches "${wanted}". Use a client name or id from this screen (list them with ui_snapshot_app).`,
      );
    }
    throw createInspectorCommandClientError(
      "invalid_request",
      `${matches.length} clients match "${wanted}" — pass the client id instead (ids are in ui_snapshot_app).`,
    );
  };

  const viewForSnapshot = isDesignPath
    ? "design"
    : detailHostId
      ? "detail"
      : topTab;

  useSurfaceAgentBridge({
    surfaceId: "chatboxes",
    handlers: {
      publishChatbox: async (command) => {
        requireAgentOperable();
        const { payload } = command as PublishChatboxInspectorCommand;
        const target = resolveAgentHost(payload?.host);
        if (target.ownerScope?.type === "journeys") {
          throw createInspectorCommandClientError(
            "unsupported_in_mode",
            `"${target.name}" belongs to the Swarms surface and has no publish surface. Manage its journeys and runs on the Swarms screen, or publish a different client.`,
          );
        }
        suppressEnsureHostsRef.current.delete(target.hostId);
        try {
          await ensureChatboxForHost({ hostId: target.hostId } as any);
          setPreviewedHostId(target.hostId);
          const next = new URLSearchParams({ host: target.hostId });
          navigate(`${routePaths.userTesting}?${next.toString()}`);
          return {
            status: "chatbox_published",
            hostId: target.hostId,
            name: target.name,
            note: "The client's test is provisioned and selected. Copying its share link is a human action — check ui_snapshot_app for whether a link exists.",
          };
        } catch (e) {
          throw createInspectorCommandClientError(
            "execution_failed",
            e instanceof Error ? e.message : "Failed to publish the test.",
          );
        }
      },
      deleteChatbox: async (command) => {
        requireAgentOperable();
        const { payload } = command as DeleteChatboxInspectorCommand;
        const target = resolveAgentHost(payload?.host);
        const match = (agentChatboxes ?? []).find(
          (c) => c.namedHostId === target.hostId,
        );
        if (!match) {
          throw createInspectorCommandClientError(
            "invalid_request",
            `"${target.name}" has no test to delete.`,
          );
        }
        suppressEnsureHostsRef.current.add(target.hostId);
        ensureLatchRef.current.delete(target.hostId);
        try {
          await deleteChatbox({ chatboxId: match.chatboxId } as any);
          return {
            status: "chatbox_deleted",
            hostId: target.hostId,
            chatboxId: match.chatboxId,
            name: target.name,
          };
        } catch (e) {
          suppressEnsureHostsRef.current.delete(target.hostId);
          throw createInspectorCommandClientError(
            "execution_failed",
            e instanceof Error ? e.message : "Failed to delete the test.",
          );
        }
      },
    },
    snapshot: () => {
      if (!agentOperable) {
        return {
          gated: true,
          reason: "Sign in and select a project to use the User Testing tools.",
        };
      }
      const sessions = (agentSessionThreads ?? [])
        .slice(0, AGENT_SNAPSHOT_MAX_SESSIONS)
        .map((t) => ({
          id: t._id,
          startedAt: t.startedAt,
          lastActivityAt: t.lastActivityAt,
          messageCount: t.messageCount,
          toolCallCount: t.toolCallCount ?? 0,
          synthetic: t.synthetic === true,
          authType: t.authType ?? null,
          modelId: t.modelId ?? null,
        }));
      return {
        activeTab: viewForSnapshot,
        selectedHostId: activeHostId ?? null,
        selectedHostName: host?.name ?? null,
        isStandaloneSwarmHost: isJourneysHost,
        published: Boolean(chatbox),
        chatboxName: chatbox?.name ?? null,
        modelId: chatbox?.modelId ?? null,
        serverCount: chatbox?.servers.length ?? 0,
        hasPublishLink: Boolean(chatbox?.link?.token),
        sessionCount: (agentSessionThreads ?? []).length,
        sessions,
      };
    },
  });

  // --- Design -----------------------------------------------------------
  if (isDesignPath) {
    return (
      <UserTestingDesign
        projectId={projectId}
        isAuthenticated={effectiveAuth}
        onBack={goOverview}
        onSaved={(hostId) => openTest(hostId)}
      />
    );
  }

  // --- Demo detail (fixture rows for local QA) --------------------------
  if (detailHostId && isUserTestingDemoHostId(detailHostId)) {
    const demoChatbox = buildUserTestingDemoChatbox(detailHostId);
    if (!demoChatbox) {
      return (
        <div className="flex h-full items-center justify-center px-6 text-center">
          <p className="text-sm text-muted-foreground">Demo prototype not found.</p>
        </div>
      );
    }
    return (
      <UserTestingDetail
        chatbox={demoChatbox}
        initialThreadId={sessionDeepLinkThreadId}
        onBack={goOverview}
        demoThreads={USER_TESTING_DEMO_THREADS}
        isDemo
      />
    );
  }

  // --- Detail -----------------------------------------------------------
  if (detailHostId) {
    if (isLoading || hostLoading) {
      return (
        <div className="flex h-full items-center justify-center text-muted-foreground">
          <Loader2 className="mr-2 size-4 animate-spin" />
          <span className="text-sm">Loading prototype…</span>
        </div>
      );
    }

    if (!host) {
      return (
        <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
          <Inbox className="size-8 text-muted-foreground/70" />
          <p className="text-sm font-medium">Client not found</p>
          <p className="max-w-sm text-xs text-muted-foreground">
            The selected client no longer exists or isn&apos;t visible to you.
          </p>
          <Button variant="outline" size="sm" onClick={goOverview}>
            Back to User Testing
          </Button>
        </div>
      );
    }

    if (isJourneysHost) {
      return (
        <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
          <Boxes className="size-8 text-muted-foreground/70" />
          <p className="text-sm font-medium">Managed by Swarms</p>
          <p className="max-w-sm text-xs text-muted-foreground">
            This client belongs to the Swarms surface and has no user testing
            publish surface. Manage its journeys and runs there.
          </p>
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={goOverview}>
              Back to User Testing
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => navigate("/swarms")}
            >
              Go to Swarms
            </Button>
          </div>
        </div>
      );
    }

    if (!chatbox) {
      if (ensureCompletedNullHosts.has(detailHostId)) {
        return (
          <ChatboxLoadFailure
            title="Couldn't load this prototype"
            body="The backfill mutation succeeded but the chatbox query still returned nothing. Check the Convex logs for getChatboxByHostId on this client."
          />
        );
      }
      return (
        <div className="flex h-full items-center justify-center text-muted-foreground">
          <Loader2 className="mr-2 size-4 animate-spin" />
          <span className="text-sm">Provisioning prototype…</span>
        </div>
      );
    }

    return (
      <UserTestingDetail
        chatbox={chatbox}
        initialThreadId={sessionDeepLinkThreadId}
        onBack={goOverview}
        onOpenSession={(threadId) => {
          const next = new URLSearchParams(searchParams);
          next.set("session", threadId);
          setSearchParams(next, { replace: true });
        }}
      />
    );
  }

  // --- Overview / Feedback Clusters shell -------------------------------
  const usingDemoRows = !listLoading && overviewRows.length === 0;
  const displayedRows = usingDemoRows ? USER_TESTING_DEMO_ROWS : overviewRows;
  // Feedback Clusters needs a real chatbox; demo-only lists have none.
  const clustersHostId =
    previewedHostId &&
    overviewRows.some((c) => c.namedHostId === previewedHostId)
      ? previewedHostId
      : overviewRows[0]?.namedHostId ?? null;

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden">
      <div
        className="shrink-0 border-b border-border/40 px-6 py-5 sm:px-8"
        data-testid="chatboxes-tab-header-chrome"
      >
        <div className="flex flex-wrap items-start justify-between gap-4">
          <h1 className="text-2xl font-semibold tracking-tight">
            User Testing
          </h1>
          <Button onClick={goCreate}>
            <Plus className="mr-1.5 size-4" />
            Create new prototype
          </Button>
        </div>
        <p className="mt-2 text-sm text-muted-foreground">
          Pick a server, share a link, and watch real users try your experience
          in their usual client.
        </p>
        <nav
          className="mt-5 flex items-center gap-6"
          aria-label="User Testing view"
        >
          {TOP_TAB_OPTIONS.map((option) => {
            const active = topTab === option.value;
            return (
              <button
                key={option.value}
                type="button"
                aria-current={active ? "page" : undefined}
                onClick={() => setTopTab(option.value)}
                className={cn(
                  "relative pb-2 text-sm font-medium transition-colors",
                  active
                    ? "text-foreground"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                {option.label}
                {active ? (
                  <span
                    aria-hidden="true"
                    className="absolute inset-x-0 -bottom-px h-0.5 rounded-full bg-primary"
                  />
                ) : null}
              </button>
            );
          })}
        </nav>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5 sm:px-8">
        {topTab === "overview" ? (
          <div className="space-y-3">
            {usingDemoRows ? (
              <p className="text-xs text-muted-foreground">
                Showing sample prototypes for layout QA. Create a prototype
                (or open a project with published chatboxes) to replace these.
              </p>
            ) : null}
            <UserTestingOverview
              chatboxes={displayedRows}
              isLoading={listLoading}
              onOpenTest={openTest}
              onCreateTest={goCreate}
              testerCounts={
                usingDemoRows ? USER_TESTING_DEMO_TESTER_COUNTS : undefined
              }
            />
          </div>
        ) : clustersHostId ? (
          <div className="h-full min-h-[420px]">
            <ClustersBootstrap
              isAuthenticated={effectiveAuth}
              hostId={clustersHostId}
              onOpenSession={(threadId) => {
                const next = new URLSearchParams({
                  host: clustersHostId,
                  session: threadId,
                });
                navigate(`${routePaths.userTesting}?${next.toString()}`);
              }}
            />
          </div>
        ) : (
          <div className="flex h-full min-h-[420px] items-center justify-center bg-background text-foreground">
            <div className="flex max-w-md flex-col items-center gap-3 text-center">
              <Network className="h-8 w-8 text-muted-foreground" />
              <div>
                <p className="text-sm font-medium">No clusters yet</p>
                <p className="mt-1 text-xs text-muted-foreground">
                  Run a rebuild to summarize and cluster historical sessions.
                </p>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/** Load chatbox by host for Feedback Clusters when Overview hasn't opened detail yet. */
function ClustersBootstrap({
  hostId,
  isAuthenticated,
  onOpenSession,
}: {
  isAuthenticated: boolean;
  hostId: string;
  onOpenSession: (threadId: string) => void;
}) {
  const { chatbox, isLoading } = useChatboxByHostId({
    isAuthenticated,
    hostId,
  });
  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-16 text-muted-foreground">
        <Loader2 className="mr-2 size-4 animate-spin" />
        <span className="text-sm">Loading clusters…</span>
      </div>
    );
  }
  if (!chatbox) {
    return (
      <div className="flex h-full min-h-[420px] items-center justify-center bg-background text-foreground">
        <div className="flex max-w-md flex-col items-center gap-3 text-center">
          <Network className="h-8 w-8 text-muted-foreground" />
          <div>
            <p className="text-sm font-medium">No clusters yet</p>
            <p className="mt-1 text-xs text-muted-foreground">
              Run a rebuild to summarize and cluster historical sessions.
            </p>
          </div>
        </div>
      </div>
    );
  }
  return (
    <ChatboxUsagePanel
      chatbox={chatbox}
      section="insights"
      onOpenSession={onOpenSession}
    />
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
