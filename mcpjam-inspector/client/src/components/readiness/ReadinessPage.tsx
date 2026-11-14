/**
 * /readiness: rehearse a directory submission for a saved server. MCPJam's
 * rehearsal bar sits above a copy of the chosen directory's portal: its first
 * screen and the server's saved rehearsals, then Claude's form or ChatGPT's
 * plugin page.
 */
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useSearchParams } from "react-router";
import { formatDistanceToNow } from "date-fns";
import { Blocks, Plug, Upload } from "lucide-react";
import { useFeatureFlagEnabled } from "posthog-js/react";
import { directoryFlowField } from "@mcpjam/sdk/browser";
import { Button } from "@mcpjam/design-system/button";
import { cn } from "@mcpjam/design-system/cn";
import { ConformanceServerPicker } from "@/components/conformance/ConformancePageChrome";
import { ScopedNavigate } from "@/components/routing/scoped-navigate";
import type { DirectoryReadinessState } from "@/hooks/use-directory-readiness-run";
import { useDirectorySubmission } from "@/hooks/use-directory-submission";
import { useDirectoryTestPlan } from "@/hooks/use-directory-test-plan";
import { useTaskOwnerId } from "@/hooks/use-task-owner-id";
import { useProjectMembers } from "@/hooks/useProjects";
import { useProjectServers } from "@/hooks/useViews";
import { routePaths } from "@/lib/app-navigation";
import { useAppRouteContext } from "@/lib/app-route-context";
import {
  createDirectorySubmission,
  listServerSubmissions,
  type SubmissionSummary,
} from "@/lib/apis/directory-submissions-api";
import type { ServerWithName } from "@/state/app-types";
import { NO_PEOPLE, type People } from "./AnswerOrigin";
import { FieldLabels } from "./EvidenceStatus";
import { McpjamMark } from "./McpjamChecks";
import { OpenAiPortal } from "./OpenAiPortal";
import { PortalFrame } from "./PortalFrame";
import { McpjamNote } from "./PortalWidgets";
import { DIRECTORY_NAMES, RehearsalBar } from "./RehearsalBar";
import { isConfirmed, recordConfirmed } from "./test-plan-consent";
import { TestPlanConsentDialog } from "./TestPlanConsentDialog";
import "./portal-theme.css";

/** The flow each directory rehearses. */
const DIRECTORIES = ["claude", "openai"] as const;
type Directory = (typeof DIRECTORIES)[number];
const FLOWS = { claude: "claude-connector", openai: "chatgpt-plugin" };
const FLOW_NAMES: Record<string, string> = {
  "claude-connector": "MCP connector",
  "chatgpt-plugin": "ChatGPT plugin",
};
const SCOPES = { claude: "portal-claude", openai: "portal-openai" };
const NO_SERVER = { name: "" };

export interface SavedServer {
  id: string;
  server: ServerWithName;
}

const messageOf = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

function Notice({ children }: { children: ReactNode }) {
  return (
    <p className="mx-auto max-w-xl px-10 py-14 text-center text-muted-foreground">
      {children}
    </p>
  );
}

const DAY = { month: "short", day: "numeric", year: "numeric" } as const;

/** The last run, and the date of the portal capture its rules come from. */
function runStatus(run: DirectoryReadinessState, flowVersion: string): string {
  const day = new Date(flowVersion).toLocaleDateString("en-US", {
    ...DAY,
    timeZone: "UTC",
  });
  const rules = ` · Rules as of ${day}`;
  const last = run.run;
  if (run.status === "running") return "Checking your server and answers…";
  if (run.status === "error")
    return `The checks did not start. ${run.error} Try running them again.`;
  if (run.status === "unavailable") {
    return "Checks need a remote server. Choose one with an HTTP URL.";
  }
  if (last?.status === "failed") {
    const why = last.errorMessage ? ` ${last.errorMessage}` : "";
    return `The last run failed.${why} Run checks again.`;
  }
  if (last?.status !== "completed") return `Not checked yet${rules}`;
  return `Checked ${formatDistanceToNow(last.updatedAt, { addSuffix: true })}${rules}`;
}

/** MCPJam's choice of the directory whose portal the page copies. */
function DirectoryChoice({
  value,
  onChange,
}: {
  value: Directory;
  onChange: (directory: Directory) => void;
}) {
  return (
    <div
      role="group"
      aria-label="Directory"
      className="flex items-center justify-center gap-2 text-sm"
    >
      <McpjamMark />
      <span className="text-muted-foreground">Rehearse a submission to</span>
      {DIRECTORIES.map((entry) => (
        <Button
          key={entry}
          type="button"
          size="sm"
          variant={entry === value ? "secondary" : "ghost"}
          aria-pressed={entry === value}
          onClick={() => onChange(entry)}
        >
          {DIRECTORY_NAMES[entry]}
        </Button>
      ))}
    </div>
  );
}

/** ChatGPT's plugins page: its upload stands for choosing a stored plugin. */
function ChatGptStart({ busy, onStart }: { busy: boolean; onStart: () => void }) {
  return (
    <div className="space-y-4 text-left">
      <h1 className="text-2xl font-semibold">Plugins</h1>
      <button
        type="button"
        disabled={busy}
        onClick={onStart}
        className="flex w-full flex-col items-center gap-3 rounded-2xl border border-dashed border-border px-8 py-10 outline-none hover:bg-accent/60 focus-visible:ring-2 focus-visible:ring-ring"
      >
        <span className="flex size-12 items-center justify-center rounded-full bg-accent">
          <Upload aria-hidden="true" className="size-5" />
        </span>
        <span className="font-medium">Upload new or existing plugin</span>
      </button>
      <McpjamNote>
        MCPJam rehearses a plugin stored in this project. Choose it on the next
        screen.
      </McpjamNote>
    </div>
  );
}

/** Claude's first screen: what to submit. */
function ClaudeStart({ busy, onStart }: { busy: boolean; onStart: () => void }) {
  const card =
    "flex flex-1 flex-col items-center gap-3 rounded-2xl bg-card px-8 py-8 text-center";
  const icon =
    "flex size-12 items-center justify-center rounded-full bg-accent";
  return (
    <>
      <div className="space-y-3">
        <h1 className="font-serif text-3xl">
          What would you like to submit?
        </h1>
        <p className="text-muted-foreground">
          Everything in the Claude Directory is called a plugin, whether it’s
          a full bundle or a single MCP connector.
        </p>
      </div>
      <div className="flex gap-6">
        <div className={cn(card, "opacity-60")}>
          <span className={icon}>
            <Plug aria-hidden="true" className="size-5" />
          </span>
          <span className="font-medium">Plugin bundle</span>
          <span className="text-sm text-muted-foreground">
            A hosted collection of files, served from a GitHub repository. It
            can include skills, commands, agents, hooks, and MCP servers.
          </span>
          <span className="rounded bg-foreground/10 px-1.5 py-0.5 text-xs">
            MCPJam: rehearsal not available yet
          </span>
        </div>
        <button
          type="button"
          disabled={busy}
          onClick={onStart}
          className={cn(
            card,
            "outline-none hover:bg-accent/60 focus-visible:ring-2 focus-visible:ring-ring",
          )}
        >
          <span className={icon}>
            <Blocks aria-hidden="true" className="size-5" />
          </span>
          <span className="font-medium">MCP connector</span>
          <span className="text-sm text-muted-foreground">
            One remote MCP server, which can be listed by itself with its own
            controls and metrics. MCP connectors can also be linked to Plugin
            bundles.
          </span>
        </button>
      </div>
    </>
  );
}

/** The portal's first screen, then the server's saved rehearsals. */
function PortalStart({
  projectId,
  serverId,
  directory,
  onDirectory,
  onOpen,
}: {
  projectId: string;
  serverId: string;
  directory: Directory;
  onDirectory: (directory: Directory) => void;
  onOpen: (submissionId: string) => void;
}) {
  const [saved, setSaved] = useState<SubmissionSummary[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    listServerSubmissions(projectId, serverId, controller.signal).then(
      setSaved,
      (failure: unknown) => {
        if (controller.signal.aborted) return;
        setError(
          `Saved rehearsals did not load. ${messageOf(failure)} Reload the page to try again.`,
        );
      },
    );
    return () => controller.abort();
  }, [projectId, serverId]);
  const start = async () => {
    setBusy(true);
    try {
      const scope = { projectId, serverId, flowId: FLOWS[directory] };
      const key = `ui-${serverId}-${Date.now()}`;
      onOpen((await createDirectorySubmission(scope, key)).id);
    } catch (failure) {
      setError(
        `The rehearsal did not start. ${messageOf(failure)} Try starting it again.`,
      );
      setBusy(false);
    }
  };
  const ours = saved.filter((entry) => entry.directory === directory);
  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto max-w-4xl space-y-8 px-10 py-14 text-center">
        <DirectoryChoice value={directory} onChange={onDirectory} />
        {directory === "openai" ? (
          <ChatGptStart busy={busy} onStart={() => void start()} />
        ) : (
          <ClaudeStart busy={busy} onStart={() => void start()} />
        )}
        {error ? (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : null}
        {ours.length > 0 ? (
          <section className="space-y-2 text-left">
            <h2 className="flex items-center gap-2 text-sm font-medium">
              <McpjamMark />
              Saved rehearsals for this server
            </h2>
            <ul className="divide-y divide-border rounded-xl bg-card px-4">
              {ours.map((entry) => (
                <li
                  key={entry.id}
                  className="flex items-center gap-4 py-3 text-sm"
                >
                  <span className="min-w-0 flex-1">
                    {entry.title ?? FLOW_NAMES[entry.flowId]}
                    <span className="block text-muted-foreground">
                      Edited{" "}
                      {formatDistanceToNow(entry.updatedAt, {
                        addSuffix: true,
                      })}
                    </span>
                  </span>
                  <Button
                    type="button"
                    size="sm"
                    variant="secondary"
                    onClick={() => onOpen(entry.id)}
                  >
                    Open
                  </Button>
                </li>
              ))}
            </ul>
          </section>
        ) : null}
      </div>
    </div>
  );
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
  const selectedServer = servers.find((entry) => entry.server.name === selected);
  const [open, setOpen] = useState<{ serverId: string; id: string } | null>(
    null,
  );
  // A submission belongs to one server: choosing another closes it.
  const openId = linkedSubmissionId ?? (open && open.serverId === selectedServer?.id ? open.id : null);
  const [choice, setChoice] = useState<Directory>("claude");
  const session = useDirectorySubmission({
    projectId: projectId ?? "",
    submissionId: projectId ? openId : null,
    server: selectedServer?.server ?? NO_SERVER,
  });
  const { flow, view, run } = session;
  const chosen = linkedSubmissionId && view
    ? servers.find((entry) => entry.id === view.serverId)
    : selectedServer;
  useEffect(() => {
    if (linkedSubmissionId && chosen && chosen.server.name !== selected) {
      onSelect(chosen.server.name);
    }
  }, [linkedSubmissionId, chosen, selected, onSelect]);
  const close = () => {
    setOpen(null);
    onSubmissionChange?.(null);
  };
  // The flow outlives a closed submission: it names the directory only
  // while one is open.
  const directory = view && flow ? flow.directory : choice;
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
      void session.startRun(planRevision);
    }
  };
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
  const serverUrl = config && "url" in config ? config.url : undefined;
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
  } else if (openId && session.error) {
    body = <Notice>{session.error}</Notice>;
  } else if (openId && !view) {
    body = <Notice>Opening the rehearsal…</Notice>;
  } else if (!chosen) {
    body = (
      <Notice>
        {servers.length === 0 && !loading
          ? "Save a server on Connect, then choose it here to rehearse its submission."
          : "Choose a saved server to rehearse its submission."}
      </Notice>
    );
  } else if (!openId) {
    body = (
      <PortalStart
        projectId={projectId}
        serverId={chosen.id}
        directory={choice}
        onDirectory={setChoice}
        onOpen={(id) => {
          setOpen({ serverId: chosen.id, id });
          onSubmissionChange?.(id);
        }}
      />
    );
  } else if (flow && view && flow.directory === "openai") {
    body = (
      <OpenAiPortal
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
          flow={flow}
          view={view}
          session={session}
          testPlan={plan}
          serverUrl={serverUrl}
          serverName={chosen.server.name}
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
      <RehearsalBar
        directory={DIRECTORY_NAMES[directory]}
        counts={counts}
        server={
          <ConformanceServerPicker
            servers={servers.map((entry) => entry.server)}
            loading={loading}
            selectedName={chosen?.server.name ?? null}
            onSelect={(name) => {
              close();
              onSelect(name);
            }}
          />
        }
        status={
          !view || !flow
            ? "Not checked yet"
            : needsVersion
              ? "Choose a plugin version to run checks."
              : runStatus(run, flow.version)
        }
        canRun={Boolean(view) && run.status !== "unavailable" && !needsVersion}
        running={run.status === "running"}
        hasRun={Boolean(view?.lastRunId)}
        planRevision={planRevision}
        onRun={startRun}
      />
      <div
        className={cn(
          SCOPES[directory],
          "flex min-h-0 flex-1 flex-col bg-background text-foreground",
        )}
      >
        {body}
      </div>
      {pending ? (
        <TestPlanConsentDialog
          saved={pending.saved}
          serverName={chosen?.server.name ?? ""}
          onConfirm={() => {
            setConfirming(null);
            recordConfirmed(pending.scope, pending.saved.revision);
            void session.startRun(pending.saved.revision);
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
