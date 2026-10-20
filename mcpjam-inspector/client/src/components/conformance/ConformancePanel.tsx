import { useState, useMemo } from "react";
import { Button } from "@mcpjam/design-system/button";
import { DirectoryReadinessSection } from "@/components/conformance/directory-readiness/DirectoryReadinessSection";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@mcpjam/design-system/select";
import { EmptyState } from "@/components/ui/empty-state";
import {
  Loader2,
  ChevronDown,
  ChevronRight,
  AlertTriangle,
  FlaskConical,
} from "lucide-react";
import type { ServerWithName } from "@/hooks/use-app-state";
// Import from the browser-safe SDK entry — the top-level `@mcpjam/sdk` pulls
// Node-only transitive deps (MCP client SDK uses `node:stream`, etc.) which
// break the Vite browser bundle.
import {
  APPS_CHECK_CATALOG,
  CHECK_ERAS,
  CONFORMANCE_CHECK_METADATA,
  MCP_APPS_CHECK_IDS,
  MCP_CHECK_IDS,
  MCP_PROTOCOL_VERSIONS,
  MCP_TASKS_CHECK_IDS,
  PROTOCOL_CHECK_CATALOG,
  PROTOCOL_VERSION_ERAS,
  TASKS_CHECK_CATALOG,
  type ConformanceScore,
  type OAuthConformanceCheckId,
} from "@mcpjam/sdk/browser";
import { ScoreHeadline } from "./ScoreHeadline";
import {
  CatalogRow,
  CheckRow,
  OAuthStepRow,
  pendingIdSet,
  type CatalogEntry,
} from "./ConformanceCheckRows";
import {
  useConformanceRun,
  type ProtocolVersionPin,
  type SuiteState,
} from "@/hooks/use-conformance-run";
import {
  PersistConformanceRun,
  type ConformancePersistConfig,
} from "@/components/conformance/PersistConformanceRun";

/**
 * The protocol suite is era-gated: a pinned version runs only its own era's
 * checks. With a pin we filter to exactly what will run; on "auto" the era is
 * unknown until the connection negotiates, so we list everything and tag the
 * checks that are era-restricted rather than implying they all apply.
 */
function protocolCatalog(pin: ProtocolVersionPin): CatalogEntry[] {
  const pinnedEra = pin === "auto" ? undefined : PROTOCOL_VERSION_ERAS[pin];
  return MCP_CHECK_IDS.filter((id) => {
    const eras = CHECK_ERAS[id] as readonly string[];
    return pinnedEra === undefined || eras.includes(pinnedEra);
  }).map((id) => {
    const eras = CHECK_ERAS[id] as readonly string[];
    return {
      id,
      ...PROTOCOL_CHECK_CATALOG[id],
      note:
        pinnedEra === undefined && eras.length === 1
          ? `${eras[0]} only`
          : undefined,
    };
  });
}

const APPS_CATALOG: CatalogEntry[] = MCP_APPS_CHECK_IDS.map((id) => ({
  id,
  ...APPS_CHECK_CATALOG[id],
}));

const TASKS_CATALOG: CatalogEntry[] = MCP_TASKS_CHECK_IDS.map((id) => ({
  id,
  ...TASKS_CHECK_CATALOG[id],
}));

// Only the post-flow checks have static identities. The authorization flow
// steps themselves depend on the server's registration strategy and protocol
// version, so they are discovered during the run rather than listed here.
const OAUTH_CATALOG: CatalogEntry[] = (
  Object.keys(CONFORMANCE_CHECK_METADATA) as OAuthConformanceCheckId[]
).map((id) => ({
  id,
  title: CONFORMANCE_CHECK_METADATA[id].title,
  description: CONFORMANCE_CHECK_METADATA[id].summary,
}));

function SuiteSection({
  title,
  state,
  catalog,
  catalogNote,
  hasResult,
  score,
  children,
}: {
  title: string;
  state: SuiteState;
  /** What this suite runs, shown until a real result replaces it. */
  catalog: CatalogEntry[];
  catalogNote?: string;
  hasResult: boolean;
  /** This suite's score chip, rendered beside the verdict badge. */
  score?: ConformanceScore;
  children?: React.ReactNode;
}) {
  // `null` follows the suite: one that is running or finished opens itself, an
  // idle one stays shut. Clicking pins an explicit choice until the next run
  // remounts. Tracking `running` — not just `hasResult` — matters most for
  // OAuth, whose section would otherwise snap shut the moment the browser
  // callback lands and the run moves from "waiting for auth" to polling.
  const [override, setOverride] = useState<boolean | null>(null);
  const running = state.status === "running";
  const collapsible = state.status !== "unavailable";
  const expanded = collapsible && (override ?? (hasResult || running));

  const badge = (() => {
    if (state.status === "running") {
      return (
        <span className="flex items-center gap-1 text-[10px] text-muted-foreground">
          <Loader2 className="h-3 w-3 animate-spin" /> Running
        </span>
      );
    }
    if (state.status === "unavailable") {
      return (
        <span className="text-[10px] text-muted-foreground">Unavailable</span>
      );
    }
    if (state.status === "error") {
      return <span className="text-[10px] text-red-400">Error</span>;
    }
    if (state.status === "done") {
      if (state.verdict === "failed") {
        return <span className="text-[10px] text-red-400">Failed</span>;
      }
      if (state.verdict === "incomplete") {
        return <span className="text-[10px] text-amber-500">Incomplete</span>;
      }
      return <span className="text-[10px] text-green-500">Passed</span>;
    }
    return null;
  })();

  return (
    <div className="rounded-md border border-border/50 overflow-hidden">
      <button
        type="button"
        className="w-full flex items-center justify-between gap-2 px-3 py-2 bg-muted/30 text-left transition-colors enabled:hover:bg-muted/50 disabled:cursor-default"
        onClick={() => setOverride(!expanded)}
        disabled={!collapsible}
        aria-expanded={collapsible ? expanded : undefined}
      >
        <span className="flex items-center gap-1.5 min-w-0">
          {collapsible &&
            (expanded ? (
              <ChevronDown className="h-3.5 w-3.5 text-muted-foreground flex-shrink-0" />
            ) : (
              <ChevronRight className="h-3.5 w-3.5 text-muted-foreground flex-shrink-0" />
            ))}
          <span className="text-sm font-medium truncate">{title}</span>
        </span>
        <span className="flex items-center gap-2">
          {score && score.score !== null && (
            <span className="text-[10px] font-semibold tabular-nums text-foreground">
              {score.score}/100
            </span>
          )}
          {badge}
        </span>
      </button>
      <div className="px-2 py-1">
        {state.status === "unavailable" && state.unavailableReason && (
          <div className="flex items-center gap-1.5 px-1 py-2 text-xs text-muted-foreground">
            <AlertTriangle className="h-3 w-3 flex-shrink-0" />
            {state.unavailableReason}
          </div>
        )}
        {state.status === "error" && state.error && (
          <div className="px-1 py-2 text-xs text-red-400">{state.error}</div>
        )}
        {expanded &&
          (hasResult ? (
            children
          ) : running ? (
            // Mid-run with nothing to show yet: the catalog would read as
            // "not run yet", which is exactly wrong while the run is live.
            <div className="flex items-center gap-2 px-1 py-3 text-xs text-muted-foreground">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              Running {catalog.length} checks...
            </div>
          ) : (
            <div>
              <div className="px-1 py-1 text-[10px] text-muted-foreground">
                {catalog.length} checks in this suite — not run yet.
                {catalogNote ? ` ${catalogNote}` : ""}
              </div>
              {catalog.map((entry) => (
                <CatalogRow key={entry.id} entry={entry} />
              ))}
            </div>
          ))}
      </div>
    </div>
  );
}

function ConformanceContent({
  server,
  persist,
}: {
  server: ServerWithName;
  persist?: ConformancePersistConfig;
}) {
  // Run state, per-suite scores and the pooled headline all live in the shared
  // hook — score.mcpjam.com runs the same four suites and must pool them the
  // same way. Rendering stays here.
  const snapshot = useConformanceRun({ server });
  const {
    protocol,
    apps,
    tasks,
    oauth,
    versionPin,
    setVersionPin,
    runVersion,
    runAll,
    protocolScore,
    appsScore,
    tasksScore,
    oauthScore,
    pooledScore,
    oauthNotScored,
    isRunning,
  } = snapshot;

  const protocolChecks = useMemo(
    () => protocolCatalog(versionPin),
    [versionPin],
  );
  const protocolPendingIds = pendingIdSet(protocol.result);
  const tasksPendingIds = pendingIdSet(tasks.result);

  return (
    <div className="flex h-full flex-col overflow-hidden">
      {persist ? (
        <PersistConformanceRun
          persist={persist}
          server={server}
          snapshot={snapshot}
        />
      ) : null}
      <div className="space-y-1 border-b border-border/50 pb-4">
        <h2 className="text-lg font-semibold">Conformance</h2>
        <p className="text-sm text-muted-foreground">
          Run Protocol, Apps, Tasks, and OAuth checks against {server.name}.{" "}
          Directory readiness grades it against Anthropic's, OpenAI's and Meta's
          (Muse) published rules.
        </p>
      </div>

      {pooledScore && pooledScore.score !== null && (
        <div className="mt-4">
          <ScoreHeadline score={pooledScore} oauthNotScored={oauthNotScored} />
        </div>
      )}

      <div className="mt-4 flex items-center justify-between gap-2">
        <Button size="sm" onClick={runAll} disabled={isRunning}>
          {isRunning ? (
            <>
              <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
              Running...
            </>
          ) : (
            "Run available checks"
          )}
        </Button>
        <div className="flex items-center gap-2">
          <label
            htmlFor="conformance-protocol-version"
            className="text-xs text-muted-foreground"
          >
            Protocol version
          </label>
          <Select
            value={versionPin}
            onValueChange={(value) =>
              setVersionPin(value as ProtocolVersionPin)
            }
            disabled={isRunning}
          >
            <SelectTrigger
              id="conformance-protocol-version"
              className="h-8 w-[170px] text-xs"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="auto">Auto (negotiated)</SelectItem>
              {MCP_PROTOCOL_VERSIONS.map((version) => (
                <SelectItem key={version} value={version}>
                  {version}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      <div className="mt-4 space-y-4 overflow-y-auto pr-1">
        <SuiteSection
          key={`${runVersion}-protocol`}
          title="Protocol"
          state={protocol}
          score={protocolScore}
          catalog={protocolChecks}
          catalogNote={
            versionPin === "auto"
              ? "The negotiated version decides which era's checks run."
              : undefined
          }
          hasResult={Boolean(protocol.result)}
        >
          {protocol.result ? (
            <div>
              <div className="px-1 py-1 text-[10px] text-muted-foreground">
                {protocol.result.summary}
              </div>
              {(protocol.result.readiness ?? []).length > 0 && (
                <div className="mx-1 my-1 space-y-1 rounded-sm border border-amber-500/50 px-2 py-1.5">
                  {(protocol.result.readiness ?? []).map((warning) => (
                    <div
                      key={warning.id}
                      className="flex items-start gap-1.5 text-[11px]"
                    >
                      <AlertTriangle className="mt-0.5 h-3 w-3 flex-shrink-0 text-amber-500" />
                      <span className="min-w-0">
                        <span className="font-medium">{warning.title}</span>{" "}
                        <span className="text-muted-foreground">
                          ({warning.specStrength})
                        </span>{" "}
                        — {warning.message}
                      </span>
                    </div>
                  ))}
                </div>
              )}
              {protocol.result.checks.map((check) => (
                <CheckRow
                  key={`${runVersion}-${check.id}`}
                  check={check}
                  pending={protocolPendingIds.has(check.id)}
                />
              ))}
            </div>
          ) : null}
        </SuiteSection>

        <SuiteSection
          key={`${runVersion}-apps`}
          title="Apps"
          state={apps}
          score={appsScore}
          catalog={APPS_CATALOG}
          hasResult={Boolean(apps.result)}
        >
          {apps.result ? (
            <div>
              <div className="px-1 py-1 text-[10px] text-muted-foreground">
                {apps.result.summary}
              </div>
              {apps.result.checks.map((check) => (
                <CheckRow key={`${runVersion}-${check.id}`} check={check} />
              ))}
            </div>
          ) : null}
        </SuiteSection>

        <SuiteSection
          key={`${runVersion}-tasks`}
          title="Tasks"
          state={tasks}
          score={tasksScore}
          catalog={TASKS_CATALOG}
          hasResult={Boolean(tasks.result)}
        >
          {tasks.result ? (
            <div>
              <div className="px-1 py-1 text-[10px] text-muted-foreground">
                {tasks.result.summary} (wire: {tasks.result.discovery.wire})
              </div>
              {tasks.result.checks.map((check) => (
                <CheckRow
                  key={`${runVersion}-${check.id}`}
                  check={check}
                  pending={tasksPendingIds.has(check.id)}
                />
              ))}
            </div>
          ) : null}
        </SuiteSection>

        <SuiteSection
          key={`${runVersion}-oauth`}
          title="OAuth"
          state={oauth}
          score={oauthScore}
          catalog={OAUTH_CATALOG}
          catalogNote="The authorization flow steps are recorded as the run proceeds."
          hasResult={Boolean(oauth.result) || Boolean(oauth.waitingForAuth)}
        >
          {oauth.waitingForAuth ? (
            <div className="flex items-center gap-2 px-1 py-3 text-xs text-muted-foreground">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              Waiting for browser authorization...
            </div>
          ) : oauth.result ? (
            <div>
              <div className="px-1 py-1 text-[10px] text-muted-foreground">
                {oauth.result.summary}
              </div>
              {oauth.result.steps.map((step) => (
                <OAuthStepRow key={`${runVersion}-${step.step}`} step={step} />
              ))}
            </div>
          ) : null}
        </SuiteSection>

        {/*
          DELIBERATELY OUTSIDE `runAll` AND THE POOLED SCORE. A hosted
          readiness run takes minutes, so joining the shared `isRunning` would
          hold the Run button and the protocol-version select hostage for its
          duration — and readiness produces lanes and coverage rather than
          passed/failed checks, so there is no number to pool. Each section
          owns its own run control.
        */}
        <DirectoryReadinessSection publisher="claude" server={server} />
        <DirectoryReadinessSection publisher="openai" server={server} />
        <DirectoryReadinessSection publisher="muse" server={server} />
      </div>
    </div>
  );
}

export function ConformanceTab({
  server,
  persist,
}: {
  server?: ServerWithName | null;
  persist?: ConformancePersistConfig;
}) {
  // In hosted mode `selectedMCPConfig` can arrive as a stub with falsy name
  // and/or missing config while the project is still hydrating — treat any
  // non-connected shape as "no server selected" so the panel never runs
  // against `undefined` (which would surface as "Hosted server not found
  // for 'undefined'" when Apps conformance calls the hosted resolver).
  if (!server || !server.name || server.name === "none" || !server.config) {
    return (
      <EmptyState
        icon={FlaskConical}
        title="No server selected"
        description="Select a connected server above to run conformance checks."
        className="h-full"
      />
    );
  }

  return (
    <div className="h-full overflow-hidden p-4 lg:p-6">
      <ConformanceContent key={server.name} server={server} persist={persist} />
    </div>
  );
}
