/**
 * /readiness: rehearse a directory submission for a saved server. MCPJam's
 * rehearsal bar sits above a copy of the Claude portal: its first screen
 * (what to submit, then the server's saved rehearsals), then the form.
 */
import { useEffect, useState, type ReactNode } from "react";
import { formatDistanceToNow } from "date-fns";
import { Blocks, Plug } from "lucide-react";
import { useFeatureFlagEnabled } from "posthog-js/react";
import { Button } from "@mcpjam/design-system/button";
import { cn } from "@mcpjam/design-system/cn";
import { ConformanceServerPicker } from "@/components/conformance/ConformancePageChrome";
import { ScopedNavigate } from "@/components/routing/scoped-navigate";
import type { DirectoryReadinessState } from "@/hooks/use-directory-readiness-run";
import { useDirectorySubmission } from "@/hooks/use-directory-submission";
import { useProjectServers } from "@/hooks/useViews";
import { routePaths } from "@/lib/app-navigation";
import { useAppRouteContext } from "@/lib/app-route-context";
import {
  createDirectorySubmission,
  listServerSubmissions,
  type SubmissionSummary,
} from "@/lib/apis/directory-submissions-api";
import type { ServerWithName } from "@/state/app-types";
import { McpjamMark } from "./McpjamChecks";
import { PortalFrame } from "./PortalFrame";
import { DIRECTORY_NAMES, RehearsalBar } from "./RehearsalBar";
import "./portal-theme.css";

/** The one flow with a rehearsal so far: Claude's MCP connector. */
const FLOW_ID = "claude-connector";
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

/** The portal's first screen, then the server's saved rehearsals. */
function PortalStart({
  projectId,
  serverId,
  onOpen,
}: {
  projectId: string;
  serverId: string;
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
      const scope = { projectId, serverId, flowId: FLOW_ID };
      const key = `ui-${serverId}-${Date.now()}`;
      onOpen((await createDirectorySubmission(scope, key)).id);
    } catch (failure) {
      setError(
        `The rehearsal did not start. ${messageOf(failure)} Try starting it again.`,
      );
      setBusy(false);
    }
  };
  const card =
    "flex flex-1 flex-col items-center gap-3 rounded-2xl bg-card px-8 py-8 text-center";
  const icon =
    "flex size-12 items-center justify-center rounded-full bg-accent";
  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto max-w-4xl space-y-8 px-10 py-14 text-center">
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
            onClick={() => void start()}
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
        {error ? (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : null}
        {saved.length > 0 ? (
          <section className="space-y-2 text-left">
            <h2 className="flex items-center gap-2 text-sm font-medium">
              <McpjamMark />
              Saved rehearsals for this server
            </h2>
            <ul className="divide-y divide-border rounded-xl bg-card px-4">
              {saved.map((entry) => (
                <li
                  key={entry.id}
                  className="flex items-center gap-4 py-3 text-sm"
                >
                  <span className="min-w-0 flex-1">
                    {entry.title ?? "MCP connector"}
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

export function ReadinessPage({
  projectId,
  servers,
  loading = false,
  selected,
  onSelect,
}: {
  projectId: string | null;
  servers: readonly SavedServer[];
  loading?: boolean;
  selected: string | null;
  onSelect: (name: string) => void;
}) {
  const chosen = servers.find((entry) => entry.server.name === selected);
  const [open, setOpen] = useState<{ serverId: string; id: string } | null>(
    null,
  );
  // A submission belongs to one server: choosing another closes it.
  const openId = open && open.serverId === chosen?.id ? open.id : null;
  const session = useDirectorySubmission({
    projectId: projectId ?? "",
    submissionId: projectId ? openId : null,
    server: chosen?.server ?? NO_SERVER,
  });
  const { flow, view, run } = session;
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
        onOpen={(id) => setOpen({ serverId: chosen.id, id })}
      />
    );
  } else if (flow && view) {
    body = (
      <PortalFrame
        flow={flow}
        view={view}
        session={session}
        serverUrl={serverUrl}
        onClose={() => setOpen(null)}
      />
    );
  } else if (session.error) {
    body = (
      <Notice>
        This rehearsal did not open. {session.error} Try opening it again.{" "}
        <Button type="button" variant="link" onClick={() => setOpen(null)}>
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
        directory={DIRECTORY_NAMES[flow?.directory ?? "claude"]}
        counts={counts}
        server={
          <ConformanceServerPicker
            servers={servers.map((entry) => entry.server)}
            loading={loading}
            selectedName={chosen?.server.name ?? null}
            onSelect={onSelect}
          />
        }
        status={view && flow ? runStatus(run, flow.version) : "Not checked yet"}
        canRun={Boolean(view) && run.status !== "unavailable"}
        running={run.status === "running"}
        hasRun={Boolean(view?.lastRunId)}
        onRun={() => void session.startRun()}
      />
      <div className="portal-claude flex min-h-0 flex-1 flex-col bg-background text-foreground">
        {body}
      </div>
    </div>
  );
}

export function ReadinessRoute() {
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
      onSelect={setSelectedServer}
    />
  );
}
