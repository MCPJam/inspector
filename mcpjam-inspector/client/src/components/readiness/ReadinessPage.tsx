/**
 * /readiness: rehearse a directory submission for a saved server. MCPJam's
 * rehearsal bar sits above a copy of the chosen directory's portal: its first
 * screen and the server's saved rehearsals, then Claude's form or ChatGPT's
 * plugin page.
 */
import { AddPluginModal } from "@/components/plugins/AddPluginModal";
import { PreviewServerIconSource } from "./PreviewServerIcon";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useSearchParams } from "react-router";
import { formatDistanceToNow } from "date-fns";
import { usePluginsEnabledState } from "@/hooks/usePluginsEnabled";
import { createDirectorySubmission, listServerSubmissions } from "@/lib/apis/directory-submissions-api";
import { MarketplaceOverview } from "./MarketplaceOverview";
import { useFeatureFlagEnabled } from "posthog-js/react";
import { directoryFlowField } from "@mcpjam/sdk/browser";
import { Button } from "@mcpjam/design-system/button";
import { cn } from "@mcpjam/design-system/cn";
import { ConformanceServerPicker } from "@/components/conformance/ConformancePageChrome";
import { ScopedNavigate } from "@/components/routing/scoped-navigate";
import type { DirectoryReadinessState } from "@/hooks/use-directory-readiness-run";
import { useDirectorySubmission } from "@/hooks/use-directory-submission";
import { useTaskOwnerId } from "@/hooks/use-task-owner-id";
import { useProjectMembers } from "@/hooks/useProjects";
import { useDirectoryTestPlan } from "@/hooks/use-directory-test-plan";
import { useProjectServers } from "@/hooks/useViews";
import { routePaths } from "@/lib/app-navigation";
import { useAppRouteContext } from "@/lib/app-route-context";
import type { ServerWithName } from "@/state/app-types";
import { NO_PEOPLE, type People } from "./AnswerOrigin";
import { FieldLabels } from "./EvidenceStatus";
import { OpenAiPortal } from "./OpenAiPortal";
import { MarketplaceCards, type Marketplace } from "./MarketplaceCards";
import { PortalFrame } from "./PortalFrame";
import { ChatGptPackageTitle, RehearsalBar } from "./RehearsalBar";
import { isConfirmed, recordConfirmed } from "./test-plan-consent";
import { TestPlanConsentDialog } from "./TestPlanConsentDialog";
import "./portal-theme.css";

const SCOPES = { claude: "portal-claude", openai: "portal-openai" };
const NO_SERVER = { name: "" };

export interface SavedServer {
  id: string;
  server: ServerWithName;
}

function Notice({ children }: { children: ReactNode }) {
  return (
    <p className="mx-auto max-w-xl px-10 py-14 text-center text-muted-foreground">
      {children}
    </p>
  );
}

const DAY = { month: "short", day: "numeric", year: "numeric" } as const;

/** The last run, and the date of the portal capture its rules come from. */
function runProvenance(run: DirectoryReadinessState, flowVersion?: string): string {
  if (!flowVersion) return "";
  const day = new Date(flowVersion).toLocaleDateString("en-US", {
    ...DAY,
    timeZone: "UTC",
  });
  const checked = run.run?.status === "completed"
    ? `Checked ${formatDistanceToNow(run.run.updatedAt, { addSuffix: true })} · `
    : "";
  return `${checked}Rules as of ${day}`;
}

function runStatus(run: DirectoryReadinessState) {
  if (run.status === "running") return "Checking…";
  if (run.status === "error") return run.error ? `Checks could not start. ${run.error} Try again.` : "Checks could not start. Try again.";
  if (run.status === "unavailable") return "Choose a remote server to run checks.";
  if (run.run?.status === "failed") return run.run.errorMessage ? `Last run failed. ${run.run.errorMessage} Run checks again.` : "Last run failed. Run checks again.";
  if (run.run?.status === "cancelled") return "Last run cancelled";
  return undefined;
}

/** Answers and events name a signed-in principal by id; the page shows names. */
function usePeople(isAuthenticated: boolean, projectId: string | null) {
  const you = useTaskOwnerId();
  const { members } = useProjectMembers({ isAuthenticated, projectId });
  return useMemo((): People => {
    const names = new Map(
      members.flatMap((member) =>
        member.userId && member.user?.name
          ? [[member.userId, member.user.name] as const]
          : [],
      ),
    );
    return { you, nameOf: (id) => names.get(id) };
  }, [you, members]);
}

export function ReadinessPage({
  projectId,
  servers,
  loading = false,
  selected,
  people = NO_PEOPLE,
  linkedSubmissionId,
  onSubmissionChange,
  onSelect,
}: {
  projectId: string | null;
  servers: readonly SavedServer[];
  loading?: boolean;
  selected: string | null;
  people?: People;
  linkedSubmissionId?: string | null;
  onSubmissionChange?: (id: string | null) => void;
  onSelect: (name: string) => void;
}) {
  const pluginsEnabled = usePluginsEnabledState() === true;
  const autoStart = useRef<string | null>(null);
  const selectedServer = servers.find((entry) => entry.server.name === selected);
  const [open, setOpen] = useState<{ serverId: string; id: string } | null>(
    null,
  );
  // Each server has its own submission and saved answers.
  const openId = linkedSubmissionId ?? (open && open.serverId === selectedServer?.id ? open.id : null);
  const [lastSubmissionId, setLastSubmissionId] = useState<string>();
  const [choice, setChoice] = useState<Marketplace | null>(null);
  const session = useDirectorySubmission({
    projectId: projectId ?? "",
    submissionId: projectId ? openId : null,
    server: selectedServer?.server ?? NO_SERVER,
  });
  const { flow, view, run } = session;
  const linkedView = view?.id === linkedSubmissionId ? view : null;
  const chosen = linkedSubmissionId
    ? servers.find((entry) => entry.id === linkedView?.serverId)
    : selectedServer;
  useEffect(() => {
    if (linkedSubmissionId && chosen && chosen.server.name !== selected) {
      onSelect(chosen.server.name);
    }
  }, [linkedSubmissionId, chosen, selected, onSelect]);
  const serverSwitch = useRef<AbortController | null>(null);
  const [upload, setUpload] = useState<{ submissionId: string; open: boolean } | null>(null);
  const [switching, setSwitching] = useState(false);
  const [switchError, setSwitchError] = useState("");
  const visitedSubmissions = useRef(new Map<string, string>());
  const position = useRef<{ submissionId: string; step: string } | null>(null);
  useEffect(() => {
    setSwitching(false);
    setUpload(null);
    setSwitchError("");
    return () => serverSwitch.current?.abort();
  }, [projectId, openId]);
  const rememberStep = (step: string) => {
    if (openId) position.current = { submissionId: openId, step };
  };
  const initialStep = position.current && position.current.submissionId === openId
    ? position.current.step : undefined;
  const close = () => {
    serverSwitch.current?.abort();
    position.current = null;
    visitedSubmissions.current.clear();
    if (view && view.id === openId) {
      setLastSubmissionId(view.id);
      setChoice(view.directory);
    }
    autoStart.current = null;
    setOpen(null);
    onSubmissionChange?.(null);
  };
  // Set before the save is awaited, so a second press cannot start a second run.
  const starting = useRef(false);
  const launch = async (testPlanRevision?: number) => {
    if (starting.current) return;
    starting.current = true;
    try {
      await session.startRun(testPlanRevision);
    } finally {
      starting.current = false;
    }
  };
  const select = async (name: string) => {
    serverSwitch.current?.abort();
    setSwitching(false);
    setSwitchError("");
    const target = servers.find(entry => entry.server.name === name);
    if (!target || target.id === chosen?.id) return;
    if (!openId) {
      onSelect(name);
      return;
    }
    if (!projectId || view?.id !== openId || !flow) return;

    const request = new AbortController();
    serverSwitch.current = request;
    setSwitching(true);
    autoStart.current = null;
    try {
      if (!(await session.saveNow()) || request.signal.aborted) return;
      const rows = await listServerSubmissions(projectId, target.id, request.signal, flow.id);
      if (request.signal.aborted) return;
      const matches = rows.filter(row => row.serverId === target.id && row.flowId === flow.id);
      const previous = visitedSubmissions.current.get(target.id);
      const saved = matches.find(row => row.id === previous) ?? matches.sort((a, b) => b.updatedAt - a.updatedAt)[0];
      if (!saved && flow.directory === "openai" && !pluginsEnabled) {
        setSwitchError("Enable Agent Plugins to open a new ChatGPT submission.");
        return;
      }
      const next = saved ?? await createDirectorySubmission(
        { projectId, serverId: target.id, flowId: flow.id },
        `ui-switch-${openId}-${target.id}`,
      );
      if (request.signal.aborted) return;
      if (view.serverId) visitedSubmissions.current.set(view.serverId, openId);
      if (position.current?.submissionId === openId) position.current.submissionId = next.id;
      setChoice(flow.directory);
      setOpen({ serverId: target.id, id: next.id });
      onSubmissionChange?.(next.id);
      onSelect(name);
    } catch (error) {
      if (!request.signal.aborted) {
        setSwitchError(`Could not switch to ${name}. ${error instanceof Error ? error.message : "Try selecting it again."}`);
      }
    } finally {
      if (!request.signal.aborted) setSwitching(false);
    }
  };
  // The flow outlives a closed submission: it names the directory only
  // while one is open.
  const directory = view && flow ? flow.directory : choice ?? "claude";
  const openUpload = openId && view?.id === openId && directory === "openai" && pluginsEnabled && !switching
    ? () => setUpload({ submissionId: openId, open: true })
    : undefined;
  // A ChatGPT run grades a stored version of the plugin, so it needs one.
  const needsVersion = flow?.directory === "openai" && !view?.pluginVersionId;
  // A run starts with the saved plan revision the run button names.
  const plan = useDirectoryTestPlan({
    projectId: projectId ?? "",
    submissionId: projectId ? openId : null,
    runKey: view
      ? `${view.lastRunId ?? ""}:${view.resultsRunId ?? ""}:${run.status}`
      : "",
  });
  const planRevision = plan.saved?.revision;
  // The run waiting on the person, and the plan revision it would send.
  const [confirming, setConfirming] = useState<{
    submissionId: string;
    revision: number;
  } | null>(null);
  const scope =
    projectId && openId ? { projectId, submissionId: openId } : null;
  const startRun = () => {
    if (
      scope &&
      planRevision !== undefined &&
      !isConfirmed(scope, planRevision)
    ) {
      setConfirming({ ...scope, revision: planRevision });
    } else {
      void launch(planRevision);
    }
  };
  useEffect(() => {
    if (
      !openId || autoStart.current !== openId || view?.id !== openId || !flow ||
      !chosen || chosen.id !== selectedServer?.id || plan.saved === undefined ||
      needsVersion || run.status === "unavailable" ||
      (flow.directory === "openai" && !pluginsEnabled)
    ) return;
    autoStart.current = null;
    if (run.status !== "running") startRun();
  });
  // Shown only while the saved plan is the revision the run would send, so
  // what the person reads is what runs. A newer save hides it unanswered.
  const saved = plan.saved;
  const pending =
    scope &&
    saved &&
    confirming?.submissionId === scope.submissionId &&
    saved.revision === confirming.revision
      ? { scope, saved }
      : null;
  const config = chosen?.server.config;
  const serverUrl = config && "url" in config ? config.url?.toString() : undefined;
  const totals = (key: "blockers" | "likelyFlags" | "notChecked") =>
    (view?.steps ?? []).reduce((sum, step) => sum + step.counts[key], 0);
  const counts = view?.resultsRunId
    ? {
        blockers: totals("blockers"),
        toFix: session.issues.length,
        likelyFlags: totals("likelyFlags"),
        notChecked: totals("notChecked"),
      }
    : null;

  let body: ReactNode;
  if (!projectId) {
    body = (
      <Notice>Sign in and open a project to rehearse a submission.</Notice>
    );
  } else if (openId && !view && session.error) {
    body = (
      <Notice>
        {session.error}{" "}
        <Button type="button" variant="link" onClick={close}>
          Back to Submissions
        </Button>
      </Notice>
    );
  } else if (openId && view?.id !== openId) {
    body = <Notice>Opening the rehearsal…</Notice>;
  } else if (!openId && !choice) {
    body = (
      <MarketplaceCards key={`${projectId}:${chosen?.id}`} projectId={projectId} serverId={chosen?.id} onSelect={setChoice} />
    );
  } else if (!chosen && openId) {
    body = (
      <Notice>
        {servers.length === 0 && !loading
          ? "Save a server on Connect, then choose it here to rehearse its submission."
          : "Choose a saved server to rehearse its submission."}
      </Notice>
    );
  } else if (!openId) {
    body = (
      <MarketplaceOverview
        // Another server or project starts over: its own list, nothing busy.
        key={`${projectId}:${chosen?.id ?? "project"}:${directory}`}
        projectId={projectId}
        serverId={chosen?.id}
        directory={choice ?? "claude"}
        pluginsEnabled={pluginsEnabled}
        initialSubmissionId={lastSubmissionId}
        onOpen={(id, automatic, serverId) => {
          const target = servers.find(entry => entry.id === serverId);
          if (target && target.server.name !== selected) onSelect(target.server.name);
          position.current = null;
          visitedSubmissions.current.clear();
          autoStart.current = automatic ? id : null;
          setOpen({ serverId, id });
          onSubmissionChange?.(id);
        }}
      />
    );
  } else if (flow && view && flow.directory === "openai") {
    body = (
      <OpenAiPortal
        key={view.id}
        initialTab={initialStep}
        onTabChange={rememberStep}
        onUpload={openUpload}
        flow={flow}
        view={view}
        session={session}
        projectId={projectId}
        serverUrl={serverUrl}
        onClose={close}
      />
    );
  } else if (flow && view) {
    const labelOf = (key: string) =>
      directoryFlowField(flow, key)?.label ?? key;
    body = (
      <FieldLabels.Provider value={labelOf}>
        <PortalFrame
          key={view.id}
          initialStep={initialStep}
          onStepChange={rememberStep}
          flow={flow}
          view={view}
          session={session}
          testPlan={plan}
          serverUrl={serverUrl}
          serverName={chosen?.server.name ?? ""}
          people={people}
          onClose={close}
        />
      </FieldLabels.Provider>
    );
  } else if (session.error) {
    body = (
      <Notice>
        {`This rehearsal did not open. ${session.error} Try opening it again.`}{" "}
        <Button type="button" variant="link" onClick={close}>
          Back to Submissions
        </Button>
      </Notice>
    );
  } else {
    body = <Notice>Opening the rehearsal…</Notice>;
  }

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden">
      {openId ? <RehearsalBar
        title={directory === "openai" ? (
          <ChatGptPackageTitle projectId={projectId} pluginId={view?.pluginId} versionId={view?.pluginVersionId} />
        ) : "Claude preview"}
        counts={counts}
        packageAction={openUpload && (
          <Button type="button" size="sm" variant="outline" onClick={openUpload}>
            Upload ZIP or folder
          </Button>
        )}
        server={
          <ConformanceServerPicker
            servers={servers.map((entry) => entry.server)}
            loading={loading}
            selectedName={chosen?.server.name ?? null}
            onSelect={(name) => void select(name)}
          />
        }
        status={
          switching ? "Switching server…" : !view || !flow
            ? "Not checked yet"
            : needsVersion
              ? view.pluginId ? "Choose a package version to run checks." : "Choose a plugin package to run checks."
              : runStatus(run)
        }
        provenance={runProvenance(run, flow?.version)}
        canRun={!session.pluginSaving && !switching && view?.id === openId && Boolean(view) && (directory !== "openai" || pluginsEnabled) && run.status !== "unavailable" && !needsVersion}
        running={run.status === "running"}
        hasRun={Boolean(view?.lastRunId)}
        planRevision={planRevision}
        onRun={startRun}
      /> : null}
      {choice && !openId && <div className="flex items-center justify-between gap-4 px-6 pt-4">
        <Button variant="ghost" size="sm" onClick={() => { setLastSubmissionId(undefined); setChoice(null); }}>All marketplaces</Button>
        <ConformanceServerPicker servers={servers.map(entry => entry.server)} loading={loading} selectedName={chosen?.server.name ?? null} onSelect={name => void select(name)} />
      </div>}
      {switchError && <p role="alert" className="px-4 py-2 text-sm text-destructive">{switchError}</p>}
      <div
        inert={switching}
        className={cn(
          openId && SCOPES[directory],
          "flex min-h-0 flex-1 flex-col bg-background text-foreground",
        )}
      >
        <PreviewServerIconSource.Provider value={{ url: serverUrl, icons: chosen?.server.initializationInfo?.serverVersion?.icons }}>
          {body}
        </PreviewServerIconSource.Provider>
      </div>
      {openUpload && upload && upload.submissionId === openId && (
        <AddPluginModal
          key={upload.submissionId}
          isOpen={upload.open}
          onClose={() => setUpload({ ...upload, open: false })}
          projectId={projectId}
          onInstalled={(plugin) => void session.setPlugin(plugin)}
        />
      )}
      {pending ? (
        <TestPlanConsentDialog
          saved={pending.saved}
          serverName={chosen?.server.name ?? ""}
          onConfirm={() => {
            setConfirming(null);
            recordConfirmed(pending.scope, pending.saved.revision);
            void launch(pending.saved.revision);
          }}
          onCancel={() => setConfirming(null)}
        />
      ) : null}
    </div>
  );
}

export function ReadinessRoute() {
  const [searchParams, setSearchParams] = useSearchParams();
  const linkedSubmissionId = searchParams.get("submission");
  const onSubmissionChange = (id: string | null) => {
    setSearchParams((current) => {
      const next = new URLSearchParams(current);
      if (id) next.set("submission", id);
      else next.delete("submission");
      return next;
    });
  };
  const enabled = useFeatureFlagEnabled("mcpjam-directory-readiness");
  const {
    displayServerConfigs,
    convexProjectId,
    isAuthenticated,
    selectedServerEntry,
    setSelectedServer,
  } = useAppRouteContext();
  const { serversByName, isLoading } = useProjectServers({
    isAuthenticated,
    projectId: convexProjectId,
  });
  const people = usePeople(isAuthenticated, convexProjectId ?? null);
  // Only an explicit `false` leaves: the flag is `undefined` until PostHog
  // hydrates, and leaving then would strand a member who cold-loads the page.
  if (enabled === false)
    return <ScopedNavigate to={routePaths.servers} replace />;
  if (enabled !== true) return null;
  // A submission names a saved server, so runtime-only connections are left out.
  const servers = Object.values<ServerWithName>(
    displayServerConfigs ?? {},
  ).flatMap((server) => {
    const id = serversByName.get(server.name);
    return id ? [{ id, server }] : [];
  });
  return (
    <ReadinessPage
      projectId={convexProjectId ?? null}
      servers={servers}
      loading={isLoading}
      selected={selectedServerEntry?.name ?? null}
      people={people}
      linkedSubmissionId={linkedSubmissionId}
      onSubmissionChange={onSubmissionChange}
      onSelect={setSelectedServer}
    />
  );
}
