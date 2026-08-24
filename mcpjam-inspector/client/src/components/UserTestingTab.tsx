import { useEffect, useMemo } from "react";
import { useNavigate, useSearchParams } from "react-router";
import { AlertTriangle, Boxes, Inbox, Loader2, Plus } from "lucide-react";
import { useConvexAuth } from "convex/react";
import { Button } from "@mcpjam/design-system/button";
import { UserTestingOverviewPanel } from "@/components/scenarios/UserTestingOverviewPanel";
import { UserTestingScenarioDetail } from "@/components/scenarios/UserTestingScenarioDetail";
import { UserTestingScenarioCreateFlow } from "@/components/scenarios/UserTestingScenarioCreateFlow";
import {
  useScenario,
  useScenarioList,
  useScenarioMutations,
  useEnvironmentScenarioMutations,
} from "@/hooks/useScenarios";
import { useProjectEnvironments } from "@/hooks/useProjectEnvironments";
import { useProjectEnvironmentsEnabled } from "@/hooks/useProjectEnvironmentsEnabled";
import { environmentLabel } from "@/lib/environment-label";
import { settingsFromScenarioAccessPreset } from "@/lib/scenario-access-presets";
import { isDeliberateScenario } from "@/lib/user-testing-scenarios";
import {
  describeScenarioDeletion,
  type ScenarioBackingRetirement,
} from "@/lib/scenario-backing";
import { useHostList } from "@/hooks/useClients";
import { shouldQueryProjectId } from "@/hooks/useProjects";
import { useUsageInsights } from "@/hooks/useUsageInsights";
import { EMPTY_USAGE_FILTER } from "@/hooks/scenario-usage-filters";
import {
  buildUserTestingScenarioPath,
  parseUserTestingDetailTab,
  routePaths,
  userTestingCreatePath,
} from "@/lib/app-navigation";
import { useSurfaceAgentBridge } from "@/lib/webmcp/use-surface-agent-bridge";
import { createInspectorCommandClientError } from "@/lib/inspector-command-handlers";
import type {
  DeleteScenarioInspectorCommand,
  PublishScenarioInspectorCommand,
} from "@/shared/inspector-command.js";

/**
 * `/user-testing` — the User Testing surface. A scenario is one environment —
 * a client and the servers it can reach — published behind a share link; the
 * product question it answers is "what happened when real people used this?".
 *
 *   - `/user-testing`                    — the project's scenarios
 *   - `/user-testing/:scenarioId`        — Insights | Sessions (+ share band)
 *   - `/user-testing/:scenarioId/edit`   — setup, share, docked preview
 *
 * `:scenarioId` is the scenario's SCENARIO id. It used to be the host id, back
 * when every scenario was a client and the two were 1:1. Environment-backed
 * scenarios broke that: several can point at the same host, and the host-keyed
 * query deliberately refuses to return them. The scenario id is the one
 * identity both kinds have, and the one everything downstream — sessions,
 * clusters, insights, the share section — was already keyed by.
 *
 * Links minted under the old scheme still work: a param that matches a host
 * instead of a scenario is redirected to that host's scenario (see the
 * resolution ladder below), as is the older `?host=` query form.
 *
 * The route param is the only view state: no in-page mode flags. The auth and
 * billing gates above this component unmount and remount it several times
 * during a cold boot, and anything held in component state would not survive
 * that. The URL does.
 *
 * Internally everything is still `scenarios` — the surface id, the billing
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
  /** From `/user-testing/:scenarioId/edit`. */
  editOpen?: boolean;
}

const AGENT_SNAPSHOT_MAX_SESSIONS = 30;

export function UserTestingTab({
  projectId,
  isAuthenticated,
  scenarioId = null,
  createOpen = false,
  editOpen = false,
}: UserTestingTabProps) {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const convexAuth = useConvexAuth();
  const effectiveAuth = isAuthenticated && convexAuth.isAuthenticated;

  // The scenario list validates `:scenarioId` before anything queries it.
  // Validation is not optional — `getScenario` declares `v.id('scenarios')`, so
  // a hand-typed or stale id doesn't come back null, it throws out of
  // `useQuery` and takes the screen with it.
  // `useScenarioList`/`useHostList` report `isLoading` as "no data yet", which
  // is also true for a SKIPPED query (signed out, or no project). Distinguish
  // them here or a deep-linked scenario spins forever instead of saying why.
  const queryable = effectiveAuth && shouldQueryProjectId(projectId);
  const { scenarios, isLoading: listQueryLoading } = useScenarioList({
    isAuthenticated: effectiveAuth,
    projectId,
  });
  const listLoading = queryable && listQueryLoading;
  // Only for the Swarms dead-end below: a standalone Journeys host has no
  // scenario, so an old link to one resolves to nothing and deserves a better
  // answer than "not found".
  const { hosts, isLoading: hostsQueryLoading } = useHostList({
    isAuthenticated: effectiveAuth,
    projectId,
  });
  const hostsLoading = queryable && hostsQueryLoading;
  // What the agent's publish tool addresses, and what the snapshot advertises.
  const environments = useProjectEnvironments(queryable ? projectId : null);
  const liveEnvironments = useMemo(
    () => (environments ?? []).filter((env) => !env.archivedAt),
    [environments],
  );

  // Which rows are SCENARIOS. Every client mints a scenario row whether or not
  // anyone meant to test with it (three of them are seeded into an empty
  // project before it is ever opened), so the list filters to rows that show
  // deliberate intent — see `isDeliberateScenario`.
  //
  // Filtered CLIENT-side on purpose: the same query feeds the public API v1
  // list and the Environments page's consumer counts, and neither should
  // inherit this surface's editorial rule.
  //
  // The filter is scoped to the environments flag. A project without
  // environments has no other kind of scenario, so hiding its client rows
  // would leave it with a surface it cannot use.
  const environmentsEnabled = useProjectEnvironmentsEnabled();
  const rows = useMemo(() => {
    const all = scenarios ?? [];
    return environmentsEnabled ? all.filter(isDeliberateScenario) : all;
  }, [scenarios, environmentsEnabled]);

  // Resolution ladder. The param is a scenario id; a param that matches a HOST
  // is a link minted under the old scheme and gets redirected rather than
  // 404'd. Deliberately searches the UNFILTERED rows: a direct link to a
  // scenario the list chooses not to advertise must still open.
  const allRows = scenarios ?? [];
  const scenarioRow = scenarioId
    ? allRows.find((c) => c.scenarioId === scenarioId) ?? null
    : null;
  // `!environmentId` mirrors the backend's `getHostPublishScenario`: an
  // environment-backed row displays a host it does not belong to, and must
  // never absorb that host's legacy links.
  const legacyHostRow =
    scenarioId && !scenarioRow
      ? allRows.find((c) => c.namedHostId === scenarioId && !c.environmentId) ??
        null
      : null;
  // A Journeys-owned host is standalone — it has no scenario at all, so an old
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
    const base = buildUserTestingScenarioPath(legacyHostRow.scenarioId);
    navigate(`${base}${query ? `?${query}` : ""}${hash}`, { replace: true });
  }, [legacyHostRow, navigate, searchParams]);

  const { scenario, isLoading: scenarioQueryLoading } = useScenario({
    isAuthenticated: effectiveAuth,
    // Only query once the id is known-good; until the list resolves we know
    // nothing, which is a spinner, not a 404.
    scenarioId: scenarioRow ? scenarioRow.scenarioId : null,
  });
  const scenarioLoading = Boolean(scenarioRow) && scenarioQueryLoading;

  // Provisioning a scenario for a host that lacks one used to happen on MOUNT,
  // behind three pieces of state (a per-host latch, a suppress set for
  // intentional deletes, and a stuck-timer). All of it is gone: a scenario is
  // now addressed by the scenario that already exists, so there is nothing to
  // back-mint on the way in. A host without a scenario simply has no scenario.
  // `scenarios:ensureScenarioForHost` has no caller on this surface any more —
  // the agent's publish tool publishes an environment, like the create flow.

  // Legacy deep links: `/scenarios?host=X&session=Y` redirects here with its
  // query intact, so translate it into the scenario path. Every session link
  // copied before the rename comes through this — the ladder above then turns
  // that host id into its scenario id.
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

  // --- Agent tool group (surface "scenarios") ---------------------------
  //
  // Registered on every view so the tools work from the list as well as from a
  // scenario. Publish/delete resolve a host by name or id against the live
  // list and honor the Swarms-owned dead-end. The snapshot is REDACTED state
  // only — never transcript text, the share token, or visitor PII.
  // A truthy-but-not-yet-queryable project id (a local placeholder during
  // hydration) would advertise the tools before any query can run, so the
  // agent would get an empty snapshot and failing commands.
  const agentOperable = effectiveAuth && shouldQueryProjectId(projectId);
  const { deleteScenario, updateScenario } = useScenarioMutations();
  const { publishEnvironmentScenario } = useEnvironmentScenarioMutations();
  // Session rows for the snapshot only — the same list query the Sessions view
  // reads, unfiltered, redacted at read time.
  const { threads: agentSessionThreads } = useUsageInsights({
    sourceType: "scenario",
    sourceId: scenario?.scenarioId ?? null,
    filters: EMPTY_USAGE_FILTER,
    enabled: agentOperable && Boolean(scenario?.scenarioId),
  });

  const requireAgentOperable = () => {
    if (!agentOperable) {
      throw createInspectorCommandClientError(
        "unsupported_in_mode",
        "The User Testing tools are locked here — sign in and select a project first.",
      );
    }
  };

  /**
   * Exact resolution by id or by the name shown on screen — unknown or
   * ambiguous is `invalid_request`, never a fuzzy guess. Both commands act on
   * the wrong thing silently if resolution guesses, so it refuses instead and
   * says how to disambiguate.
   */
  const resolveAgentTarget = <T,>(
    raw: unknown,
    args: {
      field: string;
      noun: string;
      rows: T[];
      idOf: (row: T) => string;
      nameOf: (row: T) => string;
    },
  ): T => {
    if (typeof raw !== "string" || raw.trim().length === 0) {
      throw createInspectorCommandClientError(
        "invalid_request",
        `Missing required '${args.field}' string (a ${args.noun} name or id).`,
      );
    }
    const wanted = raw.trim();
    const wantedLower = wanted.toLowerCase();
    const matches = args.rows.filter(
      (row) =>
        args.idOf(row) === wanted ||
        args.nameOf(row).toLowerCase() === wantedLower,
    );
    if (matches.length === 1) return matches[0];
    if (matches.length === 0) {
      throw createInspectorCommandClientError(
        "invalid_request",
        `No ${args.noun} matches "${wanted}". Use a ${args.noun} name or id from this screen (list them with ui_snapshot_app).`,
      );
    }
    throw createInspectorCommandClientError(
      "invalid_request",
      `${matches.length} ${args.noun}s match "${wanted}" — pass the ${args.noun} id instead (ids are in ui_snapshot_app).`,
    );
  };

  const activeView = createOpen
    ? "create"
    : editOpen && scenarioId
      ? "edit"
      : scenarioId
        ? "detail"
        : "overview";

  useSurfaceAgentBridge({
    surfaceId: "scenarios",
    handlers: {
      publishScenario: async (command) => {
        requireAgentOperable();
        const { payload } = command as PublishScenarioInspectorCommand;
        // The tool publishes an environment, so a project without the
        // environments surface has nothing it can act on. Refusing beats
        // falling back to minting a client, which is the thing the scenario
        // list stopped showing.
        if (!environmentsEnabled) {
          throw createInspectorCommandClientError(
            "unsupported_in_mode",
            "Publishing a scenario needs Environments, which isn't enabled for this project. Create the scenario from the New scenario screen instead.",
          );
        }
        const target = resolveAgentTarget(payload?.environment, {
          field: "environment",
          noun: "environment",
          rows: liveEnvironments,
          idOf: (env) => env.environmentId,
          nameOf: (env) => environmentLabel(env),
        });
        try {
          const result = await publishEnvironmentScenario({
            environmentId: target.environmentId,
            ...(payload?.name ? { name: payload.name } : {}),
            ...(payload?.access
              ? {
                  mode: settingsFromScenarioAccessPreset(payload.access).mode,
                }
              : {}),
          });
          navigate(buildUserTestingScenarioPath(result.scenarioId));
          return {
            status: "scenario_published",
            scenarioId: result.scenarioId,
            environmentId: target.environmentId,
            name: result.name,
            mode: result.mode,
            // Says which happened: re-publishing keeps the existing scenario's
            // name and access, so reporting "created" either way would be a
            // lie the model then repeats to the user.
            created: result.created,
            note: result.created
              ? "The scenario is published and open. Copying its share link is a human action — check ui_snapshot_app for whether a link exists."
              : "That environment was already published; its existing scenario is open, with the name and access it already had.",
          };
        } catch (e) {
          throw createInspectorCommandClientError(
            "execution_failed",
            e instanceof Error ? e.message : "Failed to publish the scenario.",
          );
        }
      },
      deleteScenario: async (command) => {
        requireAgentOperable();
        const { payload } = command as DeleteScenarioInspectorCommand;
        // Resolved against the SAME rows the snapshot advertises, so the agent
        // can only delete something it (and the user) can see. A row the list
        // filters out is not addressable here.
        const target = resolveAgentTarget(payload?.scenario, {
          field: "scenario",
          noun: "scenario",
          rows,
          idOf: (row) => row.scenarioId,
          nameOf: (row) => row.name,
        });
        try {
          const result = (await deleteScenario({
            scenarioId: target.scenarioId,
          } as any)) as
            | { deleted?: boolean; retirement?: ScenarioBackingRetirement }
            | undefined;
          // `deleteScenario` resolves `{ deleted: false }` rather than throwing
          // when the row is already gone. Reporting success there would tell
          // the agent it removed something it did not.
          if (result?.deleted === false) {
            throw new Error(
              "The scenario was not deleted — it may already be gone.",
            );
          }
          return {
            status: "scenario_deleted",
            scenarioId: target.scenarioId,
            name: target.name,
            environmentId: target.environmentId ?? null,
            // Driven by what the mutation actually did, not by a fixed
            // sentence: a scenario created by the User Testing flow now
            // retires its private setup and client with it, while one
            // published from a saved environment still leaves that
            // environment alone. Asserting either outcome unconditionally
            // would have the model report the wrong amount of damage.
            note: describeScenarioDeletion(target.environmentId, result?.retirement),
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
        // carries. This used to be emitted twice, under both `scenarioId` and
        // `chatboxId`, so an agent on either vocabulary could read it; there is
        // only one vocabulary now.
        scenarioId: c.scenarioId,
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
        // What `ui_publish_scenario` addresses. Without this the agent would
        // have to guess an environment name, and exact resolution would refuse
        // it — the tool's own input is only discoverable here.
        environments: liveEnvironments.map((env) => ({
          environmentId: env.environmentId,
          name: environmentLabel(env),
          published: rows.some((r) => r.environmentId === env.environmentId),
        })),
      };
      if (activeView !== "detail" && activeView !== "edit") return base;
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
        detailTab:
          activeView === "edit"
            ? "edit"
            : parseUserTestingDetailTab(
                typeof window === "undefined" ? "" : window.location.search,
              ),
        selectedScenarioId: scenarioId ?? null,
        selectedHostId: scenario?.namedHostId ?? null,
        selectedHostName: scenario?.namedHostName ?? null,
        selectedEnvironment: scenario?.environmentName ?? null,
        selectedEnvironmentError: scenario?.environmentError?.code ?? null,
        // A standalone Journeys host has no share surface (the dead-end).
        isStandaloneSwarmHost: isJourneysHost,
        published: Boolean(scenario),
        scenarioName: scenario?.name ?? null,
        modelId: scenario?.modelId ?? null,
        serverCount: scenario?.servers.length ?? 0,
        // Presence only — the share link embeds a secret token that must never
        // cross the transcript. Report whether a link exists, not the URL.
        hasPublishLink: Boolean(scenario?.link?.token),
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
    // ONE create flow, both flag states. The composer's client and server-group
    // pills render without `project-environments-enabled` — only its saved-
    // environment picker is gated — so a flag-off project composes an ad-hoc
    // environment out of them instead of getting the single-server form this
    // replaces. That form could attach exactly one server and produced a
    // scenario nobody could edit afterwards, because its backing client is
    // hidden from every client surface.
    return (
      <UserTestingScenarioCreateFlow
        projectId={projectId}
        onCancel={goOverview}
        onCreateEnvironment={() => navigate(routePaths.environments)}
        onCreateScenario={async ({ environmentId, name, mode }) => {
          // The one write. Publishing applies the name and the access mode
          // in the same mutation, so the scenario is never briefly live in a
          // mode nobody asked for. Idempotent: re-publishing an environment
          // returns its existing scenario UNCHANGED rather than re-moding it.
          const result = await publishEnvironmentScenario({
            environmentId,
            name,
            mode,
          });
          navigate(buildUserTestingScenarioPath(result.scenarioId), {
            replace: true,
          });
          return { scenarioId: result.scenarioId, created: result.created };
        }}
        onSetPerTurnFeedback={async (scenarioId, settings) => {
          // A second write, because `publishEnvironmentScenario` takes no
          // `chatUi`. Both fields go together: this is the study's first and
          // only statement about its rating widget, so there is no stored
          // value for a partial patch to preserve.
          await updateScenario({
            scenarioId,
            chatUi: { surfaces: { perTurnFeedback: settings } },
          } as any);
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

    if (scenarioLoading) return <ScenarioSpinner label="Loading scenario…" />;

    if (!scenario) {
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
        scenario={scenario}
        isAuthenticated={effectiveAuth}
        editMode={editOpen}
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
            Create new study
          </Button>
        </div>
        <p className="mt-2 max-w-2xl text-sm text-muted-foreground">
          Create a study with real users or internal testers, then read what
          happened in their sessions.
        </p>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5 sm:px-8">
        <UserTestingOverviewPanel
          // The filtered rows — `undefined` while the query is still loading,
          // so the panel can tell "nothing yet" from "nothing to show".
          scenarios={scenarios === undefined ? undefined : rows}
          isLoading={listLoading}
          onOpenScenario={(id) => navigate(buildUserTestingScenarioPath(id))}
          onCreateScenario={goCreate}
          createLabel="Create new study"
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
