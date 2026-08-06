import { useEffect, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router";
import { AlertTriangle, Boxes, Inbox, Loader2, Plus } from "lucide-react";
import { useConvexAuth, useMutation } from "convex/react";
import { toast } from "@/lib/toast";
import { Button } from "@mcpjam/design-system/button";
import { UserTestingOverviewPanel } from "@/components/chatboxes/UserTestingOverviewPanel";
import { UserTestingScenarioDetail } from "@/components/chatboxes/UserTestingScenarioDetail";
import {
  useChatboxByHostId,
  useChatboxList,
  useChatboxMutations,
} from "@/hooks/useChatboxes";
import { useHostList, type HostListItem } from "@/hooks/useClients";
import { useUsageInsights } from "@/hooks/useUsageInsights";
import { EMPTY_USAGE_FILTER } from "@/hooks/chatbox-usage-filters";
import {
  buildHostsPath,
  buildUserTestingScenarioPath,
  parseUserTestingDetailTab,
  routePaths,
} from "@/lib/app-navigation";
import { useSurfaceAgentBridge } from "@/lib/webmcp/use-surface-agent-bridge";
import { createInspectorCommandClientError } from "@/lib/inspector-command-handlers";
import type {
  DeleteChatboxInspectorCommand,
  PublishChatboxInspectorCommand,
} from "@/shared/inspector-command.js";

/**
 * `/user-testing` — the User Testing surface. A scenario is one client bound to
 * one server, published behind a share link; the product question it answers is
 * "what happened when real people used this?".
 *
 *   - `/user-testing`               — the project's scenarios
 *   - `/user-testing/:scenarioId`   — one scenario: share band, then
 *                                     Sessions | Clusters
 *
 * `:scenarioId` is the scenario's HOST id. Chatboxes are 1:1 with hosts, the
 * chatbox query is keyed by host, and every link copied before this rename
 * carried `?host=` — using the host id keeps all three aligned.
 *
 * The route param is the only view state: no in-page mode flags. The auth and
 * billing gates above this component unmount and remount it several times
 * during a cold boot, and anything held in component state would not survive
 * that. The URL does.
 *
 * Internally everything is still `chatboxes` — the surface id, the billing
 * feature, the agent tool group, the Convex tables. Only the product name and
 * the path changed.
 */
interface UserTestingTabProps {
  projectId: string | null;
  isAuthenticated: boolean;
  /** From `/user-testing/:scenarioId`. Null on the list. */
  scenarioHostId?: string | null;
  /** `/user-testing/new`. Wired in the create-flow PR; inert here. */
  createOpen?: boolean;
}

const AGENT_SNAPSHOT_MAX_SESSIONS = 30;

export function UserTestingTab({
  projectId,
  isAuthenticated,
  scenarioHostId = null,
  createOpen = false,
}: UserTestingTabProps) {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const convexAuth = useConvexAuth();
  const effectiveAuth = isAuthenticated && convexAuth.isAuthenticated;

  // The host list does double duty: it backs the agent's host resolution AND
  // validates `:scenarioId`. Validation is not optional — `getChatboxByHostId`
  // declares `v.id('hosts')`, so a hand-typed or stale id doesn't come back
  // null, it throws out of `useQuery` and takes the screen with it.
  const { hosts, isLoading: hostsLoading } = useHostList({
    isAuthenticated: effectiveAuth,
    projectId,
  });
  const { chatboxes, isLoading: listLoading } = useChatboxList({
    isAuthenticated: effectiveAuth,
    projectId,
  });

  const scenarioHost: HostListItem | null = scenarioHostId
    ? hosts.find((h) => h.hostId === scenarioHostId) ?? null
    : null;
  // Only query once the id is known-good; until the list resolves we know
  // nothing, which is a spinner, not a 404.
  const queryHostId = scenarioHost ? scenarioHost.hostId : null;
  // A Journeys-owned host is standalone: it has no share surface and must
  // never be back-minted one.
  const isJourneysHost = scenarioHost?.ownerScope?.type === "journeys";

  const { chatbox, isLoading: chatboxLoading } = useChatboxByHostId({
    isAuthenticated: effectiveAuth,
    hostId: queryHostId,
  });

  // Backfill: hosts created before the 1:1 invariant landed have no chatbox.
  // Opening such a scenario fires `ensureChatboxForHost` (idempotent on the
  // host's `by_namedHost`) and the reactive query refetches with the new row.
  const ensureChatboxForHost = useMutation(
    "chatboxes:ensureChatboxForHost" as any,
  );
  // Latched per host so a transient null plus concurrent queries can't fire
  // duplicate mutations.
  const ensureLatchRef = useRef<Set<string>>(new Set());
  // Hosts whose chatbox was INTENTIONALLY deleted. The back-mint below reads a
  // reactive `chatbox === null` as drift and re-provisions; a delete has to
  // stay deleted, so suppress the remint for that host until a chatbox exists
  // again (an explicit re-publish).
  const suppressEnsureHostsRef = useRef<Set<string>>(new Set());
  // Hosts where ensure RESOLVED but the query is still returning null. That is
  // not provisioning latency — it's the backend dropping the chatbox for a
  // reason the query didn't surface. Without this we'd spin forever.
  const [ensureCompletedNullHosts, setEnsureCompletedNullHosts] = useState<
    ReadonlySet<string>
  >(() => new Set());

  useEffect(() => {
    if (!effectiveAuth) return;
    if (!queryHostId) return;
    // Wait for both the host list (ownerScope) and the chatbox query. Firing
    // while the host is unresolved would race a chatbox onto a standalone host.
    if (hostsLoading || chatboxLoading) return;
    if (isJourneysHost) return;
    if (chatbox !== null) return;
    if (suppressEnsureHostsRef.current.has(queryHostId)) return;
    if (ensureLatchRef.current.has(queryHostId)) return;
    ensureLatchRef.current.add(queryHostId);
    const targetHostId = queryHostId;
    let cancelled = false;
    let stuckTimer: ReturnType<typeof setTimeout> | undefined;
    void ensureChatboxForHost({ hostId: targetHostId } as any)
      .then(() => {
        // Convex takes a render or two to surface the new row, so flipping the
        // stuck flag synchronously here would flash the failure UI between
        // resolve and refetch. Grace window first; the effect below clears the
        // flag the moment the chatbox actually arrives.
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
            : "Failed to provision this scenario",
        );
      });
    return () => {
      cancelled = true;
      if (stuckTimer !== undefined) clearTimeout(stuckTimer);
    };
  }, [
    chatbox,
    chatboxLoading,
    effectiveAuth,
    ensureChatboxForHost,
    hostsLoading,
    isJourneysHost,
    queryHostId,
  ]);

  // Once the chatbox shows up, clear the stuck flag AND the per-host latch, so
  // a later drift (its chatbox deleted mid-session) re-arms the ensure instead
  // of silently dropping it. Both cleanups live in one effect to stay in
  // lockstep with "a chatbox is present".
  useEffect(() => {
    if (!queryHostId) return;
    if (chatbox === null || chatbox === undefined) return;
    ensureLatchRef.current.delete(queryHostId);
    suppressEnsureHostsRef.current.delete(queryHostId);
    setEnsureCompletedNullHosts((prev) => {
      if (!prev.has(queryHostId)) return prev;
      const next = new Set(prev);
      next.delete(queryHostId);
      return next;
    });
  }, [chatbox, queryHostId]);

  // Legacy deep links: `/chatboxes?host=X&session=Y` redirects here with its
  // query intact, so translate it into the scenario path. Every session link
  // copied before the rename comes through this.
  const legacyHostParam = searchParams.get("host");
  useEffect(() => {
    if (scenarioHostId) return;
    if (!legacyHostParam) return;
    const session = searchParams.get("session");
    navigate(
      buildUserTestingScenarioPath(legacyHostParam, {
        ...(session ? { session } : {}),
      }),
      { replace: true },
    );
  }, [legacyHostParam, navigate, scenarioHostId, searchParams]);

  // --- Agent tool group (surface "chatboxes") ---------------------------
  //
  // Registered on every view so the tools work from the list as well as from a
  // scenario. Publish/delete resolve a host by name or id against the live
  // list and honor the Swarms-owned dead-end. The snapshot is REDACTED state
  // only — never transcript text, the share token, or visitor PII.
  const agentOperable = effectiveAuth && Boolean(projectId);
  const { deleteChatbox } = useChatboxMutations();
  // Session rows for the snapshot only — the same list query the Sessions view
  // reads, unfiltered, redacted at read time.
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

  // Exact resolution against the loaded host list — unknown or ambiguous →
  // invalid_request, never a fuzzy guess.
  const resolveAgentHost = (raw: unknown) => {
    if (typeof raw !== "string" || raw.trim().length === 0) {
      throw createInspectorCommandClientError(
        "invalid_request",
        "Missing required 'host' string (a client name or id).",
      );
    }
    const wanted = raw.trim();
    const wantedLower = wanted.toLowerCase();
    const matches = hosts.filter(
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

  const activeView = createOpen
    ? "create"
    : scenarioHostId
    ? "detail"
    : "overview";

  useSurfaceAgentBridge({
    surfaceId: "chatboxes",
    handlers: {
      publishChatbox: async (command) => {
        requireAgentOperable();
        const { payload } = command as PublishChatboxInspectorCommand;
        const target = resolveAgentHost(payload?.host);
        // Swarms-owned dead-end: a standalone Journeys host has NO share
        // surface and must never be back-minted one — the same reason the
        // "Managed by Swarms" notice shows.
        if (target.ownerScope?.type === "journeys") {
          throw createInspectorCommandClientError(
            "unsupported_in_mode",
            `"${target.name}" belongs to the Swarms surface and has no share surface. Manage its journeys and runs on the Swarms screen, or publish a different client.`,
          );
        }
        // Explicit publish intent — lift any prior intentional-delete
        // suppression so provisioning (and future drift-remint) works again.
        suppressEnsureHostsRef.current.delete(target.hostId);
        try {
          await ensureChatboxForHost({ hostId: target.hostId } as any);
          navigate(buildUserTestingScenarioPath(target.hostId));
          return {
            status: "chatbox_published",
            hostId: target.hostId,
            name: target.name,
            note: "The client's scenario is provisioned and open. Copying its share link is a human action — check ui_snapshot_app for whether a link exists.",
          };
        } catch (e) {
          throw createInspectorCommandClientError(
            "execution_failed",
            e instanceof Error ? e.message : "Failed to publish the scenario.",
          );
        }
      },
      deleteChatbox: async (command) => {
        requireAgentOperable();
        const { payload } = command as DeleteChatboxInspectorCommand;
        const target = resolveAgentHost(payload?.host);
        const match = (chatboxes ?? []).find(
          (c) => c.namedHostId === target.hostId,
        );
        if (!match) {
          throw createInspectorCommandClientError(
            "invalid_request",
            `"${target.name}" has no scenario to delete.`,
          );
        }
        // Suppress the auto-remint BEFORE the delete lands: the reactive query
        // flipping to null must not trigger ensureChatboxForHost, or the tool
        // would report chatbox_deleted while the surface immediately reminted.
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
          // Delete failed — the chatbox still exists, so allow provisioning.
          suppressEnsureHostsRef.current.delete(target.hostId);
          throw createInspectorCommandClientError(
            "execution_failed",
            e instanceof Error ? e.message : "Failed to delete the scenario.",
          );
        }
      },
    },
    // Redacted STATE, not payloads: which view is open, the scenario list
    // (names + counts), and on a detail view whether a share link EXISTS
    // (never the URL or token) plus bounded session rows (no transcript text,
    // no visitor PII).
    snapshot: () => {
      if (!agentOperable) {
        return {
          gated: true,
          reason: "Sign in and select a project to use the User Testing tools.",
        };
      }
      const scenarios = (chatboxes ?? []).map((c) => ({
        chatboxId: c.chatboxId,
        hostId: c.namedHostId,
        name: c.name,
        client: c.hostStyle,
        serverCount: c.serverCount,
        hasPublishLink: Boolean(c.link?.token),
        uniqueTesterCount: c.uniqueTesterCount ?? null,
        lastSessionAt: c.lastSessionAt ?? null,
      }));
      const base = {
        activeView,
        scenarioCount: scenarios.length,
        scenarios,
      };
      if (activeView !== "detail") return base;
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
        ...base,
        detailTab: parseUserTestingDetailTab(
          typeof window === "undefined" ? "" : window.location.search,
        ),
        selectedHostId: scenarioHostId ?? null,
        selectedHostName: scenarioHost?.name ?? null,
        // A standalone Journeys host has no share surface (the dead-end).
        isStandaloneSwarmHost: isJourneysHost,
        published: Boolean(chatbox),
        chatboxName: chatbox?.name ?? null,
        modelId: chatbox?.modelId ?? null,
        serverCount: chatbox?.servers.length ?? 0,
        // Presence only — the share link embeds a secret token that must never
        // cross the transcript. Report whether a link exists, not the URL.
        hasPublishLink: Boolean(chatbox?.link?.token),
        sessionCount: (agentSessionThreads ?? []).length,
        sessions,
      };
    },
  });

  const goOverview = () => navigate(routePaths.userTesting);

  // --- Scenario detail --------------------------------------------------
  if (scenarioHostId) {
    if (hostsLoading) return <ScenarioSpinner label="Loading scenario…" />;

    if (!scenarioHost) {
      return (
        <ScenarioNotice
          icon={<Inbox className="size-8 text-muted-foreground/70" />}
          title="Scenario not found"
          body="This scenario no longer exists, or isn't visible to you."
          onBack={goOverview}
        />
      );
    }

    if (isJourneysHost) {
      return (
        <ScenarioNotice
          icon={<Boxes className="size-8 text-muted-foreground/70" />}
          title="Managed by Swarms"
          body="This client belongs to the Swarms surface and has no share surface. Manage its journeys and runs there."
          onBack={goOverview}
          extraAction={
            <Button
              variant="outline"
              size="sm"
              onClick={() => navigate(routePaths.swarms)}
            >
              Go to Swarms
            </Button>
          }
        />
      );
    }

    if (chatboxLoading) return <ScenarioSpinner label="Loading scenario…" />;

    if (!chatbox) {
      // Deleted on purpose (by the agent, or from the detail screen) — the
      // suppression latch is holding the remint off, so say so rather than
      // spinning on a provisioning that will never come.
      if (suppressEnsureHostsRef.current.has(scenarioHostId)) {
        return (
          <ScenarioNotice
            icon={<Inbox className="size-8 text-muted-foreground/70" />}
            title="Scenario deleted"
            body={`"${scenarioHost.name}" is no longer published. Its client is still in Connect if you want to publish it again.`}
            onBack={goOverview}
          />
        );
      }
      // Ensure returned but the query is still empty: a real failure, not
      // latency.
      if (ensureCompletedNullHosts.has(scenarioHostId)) {
        return (
          <ScenarioLoadFailure
            title="Couldn't load this scenario"
            body="The backfill mutation succeeded but the chatbox query still returned nothing. Check the Convex logs for getChatboxByHostId on this client."
          />
        );
      }
      return <ScenarioSpinner label="Provisioning this scenario…" />;
    }

    return (
      <UserTestingScenarioDetail
        chatbox={chatbox}
        hostName={scenarioHost.name}
        onBack={goOverview}
        onDeleted={() => {
          suppressEnsureHostsRef.current.add(scenarioHostId);
          ensureLatchRef.current.delete(scenarioHostId);
          goOverview();
        }}
      />
    );
  }

  // --- Scenario list ----------------------------------------------------
  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden">
      <div
        className="shrink-0 border-b border-border/40 px-6 py-5 sm:px-8"
        data-testid="user-testing-header-chrome"
      >
        <div className="flex flex-wrap items-start justify-between gap-4">
          <h1 className="text-xl font-bold tracking-tight text-foreground">
            User Testing
          </h1>
          {/* Until the create flow lands, scenarios come from Connect — every
              client there is auto-published as one. */}
          <Button size="sm" onClick={() => navigate(buildHostsPath())}>
            <Plus className="mr-1.5 size-4" />
            New client
          </Button>
        </div>
        <p className="mt-2 max-w-2xl text-sm text-muted-foreground">
          Share a scenario with real people, then read what happened in their
          sessions.
        </p>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5 sm:px-8">
        <UserTestingOverviewPanel
          chatboxes={chatboxes}
          isLoading={listLoading}
          onOpenScenario={(hostId) =>
            navigate(buildUserTestingScenarioPath(hostId))
          }
          onCreateScenario={() => navigate(buildHostsPath())}
          createLabel="New client"
        />
      </div>
    </div>
  );
}

function ScenarioSpinner({ label }: { label: string }) {
  return (
    <div className="flex h-full items-center justify-center text-muted-foreground">
      <Loader2 className="mr-2 size-4 animate-spin" />
      <span className="text-sm">{label}</span>
    </div>
  );
}

function ScenarioNotice({
  icon,
  title,
  body,
  onBack,
  extraAction,
}: {
  icon: React.ReactNode;
  title: string;
  body: string;
  onBack: () => void;
  extraAction?: React.ReactNode;
}) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
      {icon}
      <p className="text-sm font-medium">{title}</p>
      <p className="max-w-sm text-xs text-muted-foreground">{body}</p>
      <div className="flex gap-2">
        <Button variant="outline" size="sm" onClick={onBack}>
          Back to User Testing
        </Button>
        {extraAction}
      </div>
    </div>
  );
}

function ScenarioLoadFailure({ title, body }: { title: string; body: string }) {
  return (
    <div className="flex h-full items-center justify-center px-6 text-center">
      <div className="max-w-md">
        <AlertTriangle className="mx-auto size-8 text-amber-500" />
        <p className="mt-3 text-sm font-medium">{title}</p>
        <p className="mt-1 text-xs text-muted-foreground">{body}</p>
      </div>
    </div>
  );
}
