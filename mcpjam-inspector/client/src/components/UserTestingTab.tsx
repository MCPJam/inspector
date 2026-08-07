import { useEffect, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router";
import { AlertTriangle, Boxes, Inbox, Loader2, Plus } from "lucide-react";
import { useConvexAuth, useMutation } from "convex/react";
import { toast } from "@/lib/toast";
import { Button } from "@mcpjam/design-system/button";
import { UserTestingOverviewPanel } from "@/components/chatboxes/UserTestingOverviewPanel";
import { UserTestingScenarioDetail } from "@/components/chatboxes/UserTestingScenarioDetail";
import { UserTestingCreateFlow } from "@/components/chatboxes/UserTestingCreateFlow";
import {
  useChatbox,
  useChatboxList,
  useChatboxMutations,
} from "@/hooks/useChatboxes";
import { useHostList, useHostMutations } from "@/hooks/useClients";
import { shouldQueryProjectId } from "@/hooks/useProjects";
import { useUsageInsights } from "@/hooks/useUsageInsights";
import { EMPTY_USAGE_FILTER } from "@/hooks/chatbox-usage-filters";
import {
  buildUserTestingScenarioPath,
  parseUserTestingDetailTab,
  routePaths,
  userTestingCreatePath,
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
 * `:scenarioId` is the scenario's CHATBOX id. It used to be the host id, back
 * when every scenario was a client and the two were 1:1. Environment-backed
 * scenarios broke that: several can point at the same host, and the host-keyed
 * query deliberately refuses to return them. The chatbox id is the one
 * identity both kinds have, and the one everything downstream — sessions,
 * clusters, insights, the share section — was already keyed by.
 *
 * Links minted under the old scheme still work: a param that matches a host
 * instead of a chatbox is redirected to that host's scenario (see the
 * resolution ladder below), as is the older `?host=` query form.
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
  scenarioId?: string | null;
  /** From `/user-testing/new`. */
  createOpen?: boolean;
}

const AGENT_SNAPSHOT_MAX_SESSIONS = 30;

export function UserTestingTab({
  projectId,
  isAuthenticated,
  scenarioId = null,
  createOpen = false,
}: UserTestingTabProps) {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const convexAuth = useConvexAuth();
  const effectiveAuth = isAuthenticated && convexAuth.isAuthenticated;

  // The scenario list validates `:scenarioId` before anything queries it.
  // Validation is not optional — `getChatbox` declares `v.id('chatboxes')`, so
  // a hand-typed or stale id doesn't come back null, it throws out of
  // `useQuery` and takes the screen with it.
  // `useChatboxList`/`useHostList` report `isLoading` as "no data yet", which
  // is also true for a SKIPPED query (signed out, or no project). Distinguish
  // them here or a deep-linked scenario spins forever instead of saying why.
  const queryable = effectiveAuth && shouldQueryProjectId(projectId);
  const { chatboxes, isLoading: listQueryLoading } = useChatboxList({
    isAuthenticated: effectiveAuth,
    projectId,
  });
  const listLoading = queryable && listQueryLoading;
  // Still needed for the agent's host-addressed publish tool (re-pointed at
  // scenario identity in a follow-up) and for the Swarms dead-end below.
  const { hosts, isLoading: hostsQueryLoading } = useHostList({
    isAuthenticated: effectiveAuth,
    projectId,
  });
  const hostsLoading = queryable && hostsQueryLoading;

  // Resolution ladder. The param is a chatbox id; a param that matches a HOST
  // is a link minted under the old scheme and gets redirected rather than
  // 404'd.
  const rows = chatboxes ?? [];
  const scenarioRow = scenarioId
    ? rows.find((c) => c.chatboxId === scenarioId) ?? null
    : null;
  // `!environmentId` mirrors the backend's `getHostPublishChatbox`: an
  // environment-backed row displays a host it does not belong to, and must
  // never absorb that host's legacy links.
  const legacyHostRow =
    scenarioId && !scenarioRow
      ? rows.find((c) => c.namedHostId === scenarioId && !c.environmentId) ??
        null
      : null;
  // A Journeys-owned host is standalone — it has no chatbox at all, so an old
  // link to one lands here with nothing to resolve. Worth naming precisely
  // instead of "not found".
  const isJourneysHost =
    scenarioId && !scenarioRow && !legacyHostRow
      ? hosts.find((h) => h.hostId === scenarioId)?.ownerScope?.type ===
        "journeys"
      : false;

  useEffect(() => {
    if (!legacyHostRow) return;
    // Carry the WHOLE URL across — an old link may hold `tab`/`session`, and
    // the hash is how the hosted chat surface addresses a thread.
    const query = searchParams.toString();
    const hash = typeof window === "undefined" ? "" : window.location.hash;
    const base = buildUserTestingScenarioPath(legacyHostRow.chatboxId);
    navigate(`${base}${query ? `?${query}` : ""}${hash}`, { replace: true });
  }, [legacyHostRow, navigate, searchParams]);

  const { chatbox, isLoading: chatboxQueryLoading } = useChatbox({
    isAuthenticated: effectiveAuth,
    // Only query once the id is known-good; until the list resolves we know
    // nothing, which is a spinner, not a 404.
    chatboxId: scenarioRow ? scenarioRow.chatboxId : null,
  });
  const chatboxLoading = Boolean(scenarioRow) && chatboxQueryLoading;

  // Provisioning a chatbox for a host that lacks one used to happen on MOUNT,
  // behind three pieces of state (a per-host latch, a suppress set for
  // intentional deletes, and a stuck-timer). All of it is gone: a scenario is
  // now addressed by the chatbox that already exists, so there is nothing to
  // back-mint on the way in. A host without a chatbox simply has no scenario.
  //
  // The mutation itself survives for ONE caller — the agent's host-addressed
  // publish tool below, where provisioning is the explicit request rather than
  // a side effect of looking at a URL.
  const ensureChatboxForHost = useMutation(
    "chatboxes:ensureChatboxForHost" as any,
  );

  // Legacy deep links: `/chatboxes?host=X&session=Y` redirects here with its
  // query intact, so translate it into the scenario path. Every session link
  // copied before the rename comes through this — the ladder above then turns
  // that host id into its chatbox id.
  const legacyHostParam = searchParams.get("host");
  useEffect(() => {
    if (scenarioId) return;
    if (!legacyHostParam) return;
    // Carry the WHOLE URL across, minus the `host` that became the path
    // segment. An old link may hold more than `session`, and the hash is how
    // the hosted chat surface addresses a thread — dropping either turns a
    // working bookmark into a landing page.
    const rest = new URLSearchParams(searchParams);
    rest.delete("host");
    const query = rest.toString();
    const hash = typeof window === "undefined" ? "" : window.location.hash;
    const base = buildUserTestingScenarioPath(legacyHostParam);
    navigate(`${base}${query ? `?${query}` : ""}${hash}`, { replace: true });
  }, [legacyHostParam, navigate, scenarioId, searchParams]);

  // --- Agent tool group (surface "chatboxes") ---------------------------
  //
  // Registered on every view so the tools work from the list as well as from a
  // scenario. Publish/delete resolve a host by name or id against the live
  // list and honor the Swarms-owned dead-end. The snapshot is REDACTED state
  // only — never transcript text, the share token, or visitor PII.
  // A truthy-but-not-yet-queryable project id (a local placeholder during
  // hydration) would advertise the tools before any query can run, so the
  // agent would get an empty snapshot and failing commands.
  const agentOperable = effectiveAuth && shouldQueryProjectId(projectId);
  const { deleteChatbox } = useChatboxMutations();
  const { createHost } = useHostMutations();
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

  const activeView = createOpen ? "create" : scenarioId ? "detail" : "overview";

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
        try {
          // The mutation is idempotent and returns the chatbox either way, so
          // its id is what we navigate with — no round trip through the
          // legacy host-id redirect.
          const settings = (await ensureChatboxForHost({
            hostId: target.hostId,
          } as any)) as { chatboxId: string } | null;
          if (!settings?.chatboxId) {
            throw new Error("Publishing returned no scenario.");
          }
          navigate(buildUserTestingScenarioPath(settings.chatboxId));
          return {
            status: "chatbox_published",
            scenarioId: settings.chatboxId,
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
        // Host-addressed, so it deletes the host's OWN publish surface — never
        // an environment-backed row that merely displays this host (same rule
        // as the backend's `getHostPublishChatbox`).
        const match = rows.find(
          (c) => c.namedHostId === target.hostId && !c.environmentId,
        );
        if (!match) {
          throw createInspectorCommandClientError(
            "invalid_request",
            `"${target.name}" has no scenario to delete.`,
          );
        }
        try {
          await deleteChatbox({ chatboxId: match.chatboxId } as any);
          return {
            status: "chatbox_deleted",
            scenarioId: match.chatboxId,
            hostId: target.hostId,
            chatboxId: match.chatboxId,
            name: target.name,
          };
        } catch (e) {
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
      const scenarios = rows.map((c) => ({
        // The id every scenario has, and the one `/user-testing/:scenarioId`
        // now carries.
        scenarioId: c.chatboxId,
        chatboxId: c.chatboxId,
        hostId: c.namedHostId,
        name: c.name,
        client: c.hostStyle,
        environment: c.environmentName ?? null,
        // Present only when the row can't resolve — absence is "healthy",
        // not "unknown".
        environmentError: c.environmentError?.code ?? null,
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
        selectedScenarioId: scenarioId ?? null,
        selectedHostId: chatbox?.namedHostId ?? null,
        selectedHostName: chatbox?.namedHostName ?? null,
        selectedEnvironment: chatbox?.environmentName ?? null,
        selectedEnvironmentError: chatbox?.environmentError?.code ?? null,
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
  const goCreate = () => navigate(userTestingCreatePath);

  // --- Create -----------------------------------------------------------
  if (createOpen) {
    if (!projectId) {
      return (
        <ScenarioNotice
          icon={<Inbox className="size-8 text-muted-foreground/70" />}
          title="Select a project first"
          body="Scenarios belong to a project — pick one, then create a scenario in it."
          onBack={goOverview}
        />
      );
    }
    return (
      <UserTestingCreateFlow
        projectId={projectId}
        isAuthenticated={effectiveAuth}
        onCancel={goOverview}
        onCreateScenario={async ({ name, input, chatboxMode }) => {
          // The one write. `hosts.createHost` mints the host, its chatbox and
          // the access mode in a single mutation, so a half-created scenario
          // isn't reachable. It returns the host id; the route wants the
          // chatbox id, and the ladder above resolves one to the other on the
          // next render — the list has already refetched by then.
          const { hostId } = await createHost({
            projectId,
            name,
            input,
            chatboxMode,
          });
          toast.success("Scenario created");
          navigate(buildUserTestingScenarioPath(hostId), { replace: true });
          return { hostId };
        }}
      />
    );
  }

  // --- Scenario detail --------------------------------------------------
  if (scenarioId) {
    // Nothing was ever queried — signed out, or no project selected yet.
    // "Not found" would be a lie: we never looked.
    if (!queryable) {
      return (
        <ScenarioNotice
          icon={<Inbox className="size-8 text-muted-foreground/70" />}
          title="Sign in to open this scenario"
          body="Scenarios live in a project. Sign in and select the project this link belongs to."
          onBack={goOverview}
        />
      );
    }

    // The list is what validates the param, so nothing can be decided until
    // it lands. The host list only gates the Swarms dead-end below.
    if (listLoading || (!scenarioRow && !legacyHostRow && hostsLoading)) {
      return <ScenarioSpinner label="Loading scenario…" />;
    }

    // The redirect effect is already in flight; rendering "not found" for a
    // frame would flash a lie at someone following a working old link.
    if (legacyHostRow) return <ScenarioSpinner label="Loading scenario…" />;

    if (!scenarioRow) {
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
      return (
        <ScenarioNotice
          icon={<Inbox className="size-8 text-muted-foreground/70" />}
          title="Scenario not found"
          body="This scenario no longer exists, was never published, or isn't visible to you."
          onBack={goOverview}
        />
      );
    }

    if (chatboxLoading) return <ScenarioSpinner label="Loading scenario…" />;

    if (!chatbox) {
      // The row is in the list but the detail query returns nothing — the
      // scenario was deleted from under this view (another tab, the agent),
      // or its environment stopped resolving hard enough that even the
      // degraded read failed.
      return (
        <ScenarioLoadFailure
          title="Couldn't load this scenario"
          body="It may have just been deleted. Go back to User Testing to see the current list."
        />
      );
    }

    return (
      <UserTestingScenarioDetail
        chatbox={chatbox}
        onBack={goOverview}
        onDeleted={goOverview}
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
          <Button size="sm" onClick={goCreate}>
            <Plus className="mr-1.5 size-4" />
            New scenario
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
          onOpenScenario={(id) => navigate(buildUserTestingScenarioPath(id))}
          onCreateScenario={goCreate}
          createLabel="New scenario"
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
