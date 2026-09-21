import {
  dependentFilterOptions,
  selectedFilter,
} from "../evals/filter-options";
import {
  EvalListFilter,
  ALL_EVAL_FILTER_VALUES,
} from "../evals/eval-list-filter";
import { useMemo, useState, type MouseEvent } from "react";
import { formatDistanceToNow } from "date-fns";
import { AlertTriangle, Loader2, Play, Trash2 } from "lucide-react";
import { Button } from "@mcpjam/design-system/button";
import { ErrorBoundary } from "@/components/ui/error-boundary";
import { resolveHostLogoByName } from "@/lib/host-logo";
import { usePreferencesStore } from "@/stores/preferences/preferences-provider";
import { cn } from "@/lib/utils";
import { useConvexAuth } from "convex/react";
import { useHostList } from "@/hooks/useClients";
import {
  useProjectEnvironments,
  type ProjectEnvironmentView,
} from "@/hooks/useProjectEnvironments";
import { compactModelIdTail } from "@/lib/environment-label";
import { getEffectiveSuiteServers } from "../evals/helpers";
import type {
  EvalSuite,
  EvalSuiteOverviewEntry,
  EvalSuiteRun,
} from "../evals/types";

interface SuitesOverviewProps {
  environments?: readonly Pick<
    ProjectEnvironmentView,
    "environmentId" | "hostId" | "modelId"
  >[];
  hostNamesById?: ReadonlyMap<string, string>;
  hostModelsById?: ReadonlyMap<string, string>;
  overview: EvalSuiteOverviewEntry[];
  onSelectSuite: (id: string) => void;
  onRerun: (suite: EvalSuite) => void;
  onCancelRun: (runId: string) => void;
  /**
   * Deleting from the landing row is the only path that does not require
   * opening the suite first. The in-suite path (Edit → settings → Delete)
   * still exists; this is the one that works for a suite you never want to
   * look at again, including one that has never run.
   */
  onDelete?: (suite: EvalSuite) => void;
  /** Per-suite: creators and project admins only. Hides the control entirely. */
  canDeleteSuite?: (suite: EvalSuite) => boolean;
  rerunningSuiteId?: string | null;
  cancellingRunId?: string | null;
  deletingSuiteId?: string | null;
}

// Shared with User Testing's scenario list so the two landings read as one
// product. Data cells use the same pad + cols; the trailing action column is
// extra so Run/Cancel don't steal space from Suite/Client/Server.
const ROW_PAD = "flex w-full items-center gap-4 px-3";
const DATA_COLS =
  "grid min-w-0 flex-1 items-center gap-4 grid-cols-[minmax(0,1.6fr)_minmax(0,0.7fr)_minmax(0,1fr)_minmax(0,1fr)_5rem_7rem]";
const ACTION_COL = "flex w-40 shrink-0 items-center justify-end gap-1";

export function ConnectedSuitesOverview({
  projectId,
  ...props
}: SuitesOverviewProps & { projectId?: string | null }) {
  const { isAuthenticated } = useConvexAuth();
  const environments = useProjectEnvironments(projectId ?? null, {
    includeAdhoc: true,
  });
  const { hosts } = useHostList({
    isAuthenticated,
    projectId: projectId ?? null,
    includePrivateBacking: true,
  });
  return (
    <SuitesOverview
      {...props}
      environments={environments}
      hostNamesById={new Map(hosts.map((host) => [host.hostId, host.name]))}
      hostModelsById={new Map(hosts.map((host) => [host.hostId, host.modelId]))}
    />
  );
}

export function SuitesOverview(props: SuitesOverviewProps) {
  return (
    <ErrorBoundary
      fallback={
        <div
          className="flex flex-col items-center justify-center px-6 py-16 text-center"
          data-testid="evals-suites-overview-error"
        >
          <AlertTriangle className="size-8 text-warning" />
          <h2 className="mt-4 text-base font-semibold">
            Couldn&apos;t show your suites
          </h2>
          <p className="mt-1 max-w-sm text-sm text-muted-foreground">
            The list failed to render. Reload the page. This doesn&apos;t mean
            anything happened to your suites.
          </p>
        </div>
      }
    >
      <OverviewBody {...props} />
    </ErrorBoundary>
  );
}

function OverviewBody({
  environments = [],
  hostNamesById = new Map(),
  hostModelsById = new Map(),
  overview,
  onSelectSuite,
  onRerun,
  onCancelRun,
  onDelete,
  canDeleteSuite,
  rerunningSuiteId = null,
  cancellingRunId = null,
  deletingSuiteId = null,
}: SuitesOverviewProps) {
  const themeMode = usePreferencesStore((s) => s.themeMode);
  const [clientFilter, setClientFilter] = useState(ALL_EVAL_FILTER_VALUES);
  const [serverFilter, setServerFilter] = useState(ALL_EVAL_FILTER_VALUES);
  const [modelFilter, setModelFilter] = useState(ALL_EVAL_FILTER_VALUES);
  // Resolved once per suite per data change, not four times per render: the
  // model pass alone is a scan of `environments` for every environment id.
  const resolved = useMemo(() => {
    const environmentsById = new Map(
      environments.map((environment) => [
        environment.environmentId,
        environment,
      ]),
    );
    const entries = overview.map(({ suite }) => {
      const ids = suite.environmentIds?.length
        ? suite.environmentIds
            .map((id) => environmentsById.get(id)?.hostId)
            .filter((hostId): hostId is string => Boolean(hostId))
        : (suite.hostAttachments ?? []).map((host) => host.namedHostId);
      // A host id is not a name. Until `useHostList` resolves, an unnamed id
      // is UNKNOWN, not a label — printing the raw id put opaque Convex ids in
      // the column and, worse, in the filter's option list.
      const clients = [
        ...new Set(
          ids
            .map(
              (id) =>
                hostNamesById.get(id)?.trim() ||
                suite.hostAttachments
                  ?.find((host) => host.namedHostId === id)
                  ?.hostName?.trim() ||
                null,
            )
            .filter((name): name is string => Boolean(name)),
        ),
      ];
      // `null` where the model is not resolved YET, so the placeholder stays a
      // display string and never becomes a value the Model filter offers.
      const models = [
        ...new Set(
          suite.environmentIds?.length
            ? suite.environmentIds.map((id) => {
                const environment = environmentsById.get(id);
                return environment
                  ? environment.modelId ||
                      hostModelsById.get(environment.hostId) ||
                      null
                  : null;
              })
            : [suite.defaultConfig?.modelId || null],
        ),
      ];
      return [suite._id, { clients, models }] as const;
    });
    return new Map(entries);
  }, [overview, environments, hostNamesById, hostModelsById]);
  const clientsForSuite = (suite: EvalSuite) =>
    resolved.get(suite._id)?.clients ?? [];
  const modelsForSuite = (suite: EvalSuite) =>
    resolved.get(suite._id)?.models ?? [];
  const options = dependentFilterOptions(overview, {
    client: {
      selected: selectedFilter(clientFilter),
      values: ({ suite }) => clientsForSuite(suite),
    },
    model: {
      selected: selectedFilter(modelFilter),
      values: ({ suite }) =>
        modelsForSuite(suite).filter((model): model is string =>
          Boolean(model),
        ),
    },
    server: {
      selected: selectedFilter(serverFilter),
      values: ({ suite }) => getEffectiveSuiteServers(suite),
    },
  });
  const clientOptions = options.client;
  const modelOptions = options.model;
  const serverOptions = options.server;
  const isFiltering =
    modelFilter !== ALL_EVAL_FILTER_VALUES ||
    clientFilter !== ALL_EVAL_FILTER_VALUES ||
    serverFilter !== ALL_EVAL_FILTER_VALUES;

  const sortedOverview = useMemo(
    () =>
      [...overview].sort((a, b) => {
        const aTime = latestActivityAt(a);
        const bTime = latestActivityAt(b);
        return bTime - aTime;
      }),
    [overview],
  );

  const filteredOverview = sortedOverview.filter(
    ({ suite }) =>
      (clientFilter === ALL_EVAL_FILTER_VALUES ||
        clientsForSuite(suite).includes(clientFilter)) &&
      (modelFilter === ALL_EVAL_FILTER_VALUES ||
        modelsForSuite(suite).includes(modelFilter)) &&
      (serverFilter === ALL_EVAL_FILTER_VALUES ||
        getEffectiveSuiteServers(suite).includes(serverFilter)),
  );

  if (sortedOverview.length === 0) {
    return null;
  }

  return (
    <div
      className="@container/suites min-w-0"
      data-testid="evals-suites-overview"
    >
      <div className={cn(ROW_PAD, "border-b border-border/40 pb-3")} role="row">
        <div className={DATA_COLS}>
          <span
            role="columnheader"
            className="text-xs font-medium text-muted-foreground"
          >
            Suite
          </span>
          <div role="columnheader" aria-label="Client" className="min-w-0">
            <EvalListFilter
              label="Client"
              variant="header"
              className="-ml-1 min-h-8 w-full justify-start px-1"
              value={clientFilter}
              options={clientOptions}
              onChange={setClientFilter}
            />
          </div>
          <div role="columnheader" aria-label="Model" className="min-w-0">
            <EvalListFilter
              label="Model"
              variant="header"
              className="-ml-1 min-h-8 w-full justify-start px-1"
              value={modelFilter}
              options={modelOptions}
              formatOption={compactModelIdTail}
              onChange={setModelFilter}
            />
          </div>
          <div role="columnheader" aria-label="Server" className="min-w-0">
            <EvalListFilter
              label="Server"
              className="-ml-1 min-h-8 w-full justify-start px-1"
              variant="header"
              value={serverFilter}
              options={serverOptions}
              onChange={setServerFilter}
            />
          </div>
          <span
            role="columnheader"
            className="text-right text-xs font-medium text-muted-foreground"
          >
            Pass rate
          </span>
          <span
            role="columnheader"
            className="text-right text-xs font-medium text-muted-foreground"
          >
            Last run
          </span>
        </div>
        <div className={ACTION_COL}>
          {isFiltering ? (
            <Button
              variant="ghost"
              size="sm"
              className="h-7 text-[11px]"
              aria-label="Clear filters"
              onClick={() => {
                setClientFilter(ALL_EVAL_FILTER_VALUES);
                setModelFilter(ALL_EVAL_FILTER_VALUES);
                setServerFilter(ALL_EVAL_FILTER_VALUES);
              }}
            >
              Clear
            </Button>
          ) : null}
        </div>
      </div>
      <ul className="mt-1">
        {filteredOverview.map((entry) => (
          <li key={entry.suite._id}>
            <div
              className={cn(
                ROW_PAD,
                "rounded-md border border-transparent py-3 transition-colors",
                "hover:border-border/60 hover:bg-muted/40",
              )}
            >
              <button
                type="button"
                data-testid="evals-suites-overview-row"
                data-suite-id={entry.suite._id}
                onClick={() => onSelectSuite(entry.suite._id)}
                className={cn(
                  DATA_COLS,
                  "text-left",
                  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                )}
              >
                <span className="min-w-0 truncate text-sm font-medium text-foreground">
                  {entry.suite.name || "Untitled suite"}
                </span>
                <ClientCell
                  names={clientsForSuite(entry.suite)}
                  themeMode={themeMode}
                  className="flex"
                />
                <ModelCell models={modelsForSuite(entry.suite)} />
                <span className="min-w-0 truncate text-sm text-muted-foreground">
                  {serverLabel(entry.suite)}
                </span>
                <span
                  data-testid="evals-suites-overview-pass-rate"
                  className="text-right text-sm tabular-nums text-foreground"
                >
                  {passRateLabel(entry)}
                </span>
                <span className="truncate text-right text-sm text-muted-foreground">
                  {lastRunLabel(entry)}
                </span>
              </button>
              <div className={ACTION_COL}>
                <RowRunControl
                  suite={entry.suite}
                  latestRun={entry.latestRun}
                  onRerun={onRerun}
                  onCancelRun={onCancelRun}
                  rerunningSuiteId={rerunningSuiteId}
                  cancellingRunId={cancellingRunId}
                />
                {onDelete && (canDeleteSuite?.(entry.suite) ?? true) ? (
                  <RowDeleteControl
                    suite={entry.suite}
                    onDelete={onDelete}
                    deletingSuiteId={deletingSuiteId}
                  />
                ) : null}
              </div>
            </div>
          </li>
        ))}
      </ul>
      {filteredOverview.length === 0 && (
        <p className="py-10 text-center text-sm text-muted-foreground">
          No suites match these filters.
        </p>
      )}
    </div>
  );
}

function stopRowClick(event: MouseEvent) {
  event.preventDefault();
  event.stopPropagation();
}

function RowRunControl({
  suite,
  latestRun,
  onRerun,
  onCancelRun,
  rerunningSuiteId,
  cancellingRunId,
}: {
  suite: EvalSuite;
  latestRun: EvalSuiteRun | null;
  onRerun: (suite: EvalSuite) => void;
  onCancelRun: (runId: string) => void;
  rerunningSuiteId: string | null;
  cancellingRunId: string | null;
}) {
  const suiteTitle = suite.name || "Untitled suite";
  const hasServers = getEffectiveSuiteServers(suite).length > 0;
  const latestRunInProgress =
    latestRun?.status === "running" || latestRun?.status === "pending";
  const isStarting = rerunningSuiteId === suite._id && !latestRunInProgress;
  const isCancelling = Boolean(latestRun && cancellingRunId === latestRun._id);

  if (latestRunInProgress && latestRun) {
    return (
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="h-7 px-2.5"
        data-testid="evals-suites-overview-cancel"
        aria-label={`Cancel run for ${suiteTitle}`}
        disabled={isCancelling}
        onClick={(event) => {
          stopRowClick(event);
          onCancelRun(latestRun._id);
        }}
      >
        {isCancelling ? (
          <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" aria-hidden />
        ) : null}
        Cancel
      </Button>
    );
  }

  if (isStarting) {
    return (
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="h-7 px-2.5"
        data-testid="evals-suites-overview-running"
        aria-label={`Running ${suiteTitle}`}
        disabled
      >
        <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
      </Button>
    );
  }

  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      className="h-7 gap-1.5 px-2.5"
      data-testid="evals-suites-overview-run"
      aria-label={
        hasServers ? `Setup Run ${suiteTitle}` : "No servers configured"
      }
      title={hasServers ? undefined : "No servers configured"}
      disabled={!hasServers}
      onClick={(event) => {
        stopRowClick(event);
        onRerun(suite);
      }}
    >
      <Play className="h-3.5 w-3.5 shrink-0" aria-hidden />
      Setup Run
    </Button>
  );
}

function RowDeleteControl({
  suite,
  onDelete,
  deletingSuiteId,
}: {
  suite: EvalSuite;
  onDelete: (suite: EvalSuite) => void;
  deletingSuiteId: string | null;
}) {
  const isDeleting = deletingSuiteId === suite._id;
  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      className="h-7 w-7 p-0 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
      data-testid="evals-suites-overview-delete"
      aria-label={`Delete ${suite.name || "Untitled suite"}`}
      disabled={isDeleting}
      onClick={(event) => {
        stopRowClick(event);
        // Confirmation is the caller's: `EvalsTab` arms `ConfirmationDialogs`,
        // which is the same dialog every other delete path in evals uses.
        onDelete(suite);
      }}
    >
      {isDeleting ? (
        <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
      ) : (
        <Trash2 className="h-3.5 w-3.5" aria-hidden />
      )}
    </Button>
  );
}

function ClientCell({
  names,
  themeMode,
  className,
}: {
  names: string[];
  themeMode: "light" | "dark";
  className?: string;
}) {
  if (names.length === 0) {
    return (
      <span className={cn(className, "text-sm text-muted-foreground")}>-</span>
    );
  }

  return (
    <span
      className={cn(className, "min-w-0 items-center gap-2")}
      title={names.join(", ")}
    >
      <span className="flex shrink-0 -space-x-1.5">
        {names.map((name, index) => (
          <span
            key={`${name}-${index}`}
            className="inline-flex size-6 shrink-0 items-center justify-center overflow-hidden rounded-md border border-border/50 bg-background ring-1 ring-background"
          >
            <img
              src={resolveHostLogoByName(name, themeMode)}
              alt=""
              className="size-3.5 object-contain"
            />
          </span>
        ))}
      </span>
      <span className="hidden min-w-0 truncate text-sm text-foreground @min-[1100px]/suites:inline">
        {names.join(", ")}
      </span>
    </span>
  );
}

function latestActivityAt(entry: EvalSuiteOverviewEntry): number {
  return (
    entry.latestRun?.completedAt ??
    entry.latestRun?.createdAt ??
    entry.suite.updatedAt ??
    entry.suite._creationTime ??
    0
  );
}

function serverLabel(suite: EvalSuite): string {
  const names = getEffectiveSuiteServers(suite);
  if (names.length > 0) return names[0];
  return "-";
}

function passRateLabel(entry: EvalSuiteOverviewEntry): string {
  const rate = entry.latestRun?.summary?.passRate;
  if (
    typeof rate !== "number" ||
    !Number.isFinite(rate) ||
    !entry.latestRun?.summary?.total
  )
    return "—";
  return `${Math.round(rate * 100)}%`;
}

function lastRunLabel(entry: EvalSuiteOverviewEntry): string {
  const timestamp =
    entry.latestRun?.completedAt ?? entry.latestRun?.createdAt ?? null;
  if (!timestamp) return "-";
  return formatDistanceToNow(timestamp, { addSuffix: true });
}

/** `null` is a model this view could not resolve; it is shown, never filtered on. */
function ModelCell({ models }: { models: (string | null)[] }) {
  const labels = models.map((model) => model ?? "-");
  return (
    <span
      className="min-w-0 text-sm text-muted-foreground"
      title={labels.join(", ")}
    >
      <span className="hidden truncate @min-[1100px]/suites:block">
        {models
          .map((model) => (model ? compactModelIdTail(model) : "-"))
          .join(", ")}
      </span>
      <span
        className="flex min-w-0 items-center gap-1 @min-[1100px]/suites:hidden"
        data-testid="suite-compact-models"
      >
        <span className="truncate">
          {models[0] ? compactModelIdTail(models[0]) : "-"}
        </span>
        {models.length > 1 && (
          <span className="shrink-0" title={labels.slice(1).join(", ")}>
            +{models.length - 1}
          </span>
        )}
      </span>
    </span>
  );
}
