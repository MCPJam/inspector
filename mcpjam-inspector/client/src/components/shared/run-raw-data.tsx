import { useCallback, useRef, useState } from "react";
import { Database, Download, Loader2, RefreshCw } from "lucide-react";
import { useConvex } from "convex/react";
import { Button } from "@mcpjam/design-system/button";
import { JsonEditor } from "@/components/ui/json-editor";

type QueryClient = {
  query: (name: unknown, args: unknown) => Promise<unknown>;
};

type RawDataScope =
  | {
      kind: "swarm";
      projectId: string;
      swarmRunGroupId?: string;
      runIds: string[];
      snapshot: unknown;
    }
  | {
      kind: "scenario";
      scenarioId: string;
      snapshot: unknown;
    };

type QueryCapture = {
  label: string;
  query: string;
  args: Record<string, unknown>;
  status: "ok" | "error";
  data?: unknown;
  error?: string;
};

type BlobCapture = {
  label: string;
  url: string;
  status: "ok" | "error";
  data?: unknown;
  error?: string;
};

export type RunRawDataBundle = {
  schemaVersion: 1;
  exportedAt: string;
  scope: RawDataScope["kind"];
  scopeSnapshot: unknown;
  notes: string[];
  queries: QueryCapture[];
  resolvedJsonBlobs: BlobCapture[];
};

const ALL_FILTERS = { preset: "all", chips: [] };
const PAGE_SIZE = 100;
const MAX_PAGES = 100;
/**
 * How many sessions get their per-session detail queries and blob fetches.
 * The swarm path can page in up to MAX_PAGES × PAGE_SIZE rows per run, and
 * each detailed session costs several queries, so an uncapped wave turned
 * one click into tens of thousands of browser-issued queries and an
 * unbounded bundle. The scenario path is already capped at 100 by its query.
 */
const MAX_SESSION_DETAILS = 250;
const SESSION_CONCURRENCY = 4;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function captureQuery(
  client: QueryClient,
  captures: QueryCapture[],
  label: string,
  query: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  try {
    const data = await client.query(query as never, args as never);
    captures.push({ label, query, args, status: "ok", data });
    return data;
  } catch (error) {
    captures.push({
      label,
      query,
      args,
      status: "error",
      error: errorMessage(error),
    });
    return undefined;
  }
}

function objectField(value: unknown, key: string): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return (value as Record<string, unknown>)[key];
}

function stringField(value: unknown, key: string): string | null {
  const field = objectField(value, key);
  return typeof field === "string" && field.length > 0 ? field : null;
}

function arrayField(value: unknown, key: string): unknown[] {
  const field = objectField(value, key);
  return Array.isArray(field) ? field : [];
}

async function capturePaginatedQuery(
  client: QueryClient,
  captures: QueryCapture[],
  label: string,
  query: string,
  args: Record<string, unknown>,
): Promise<unknown[]> {
  const rows: unknown[] = [];
  let cursor: string | null = null;
  let pagesFetched = 0;

  try {
    while (pagesFetched < MAX_PAGES) {
      const pageArgs = {
        ...args,
        paginationOpts: { numItems: PAGE_SIZE, cursor },
      };
      const result = await client.query(query as never, pageArgs as never);
      rows.push(...arrayField(result, "page"));
      pagesFetched += 1;

      if (objectField(result, "isDone") === true) {
        captures.push({
          label,
          query,
          args,
          status: "ok",
          data: { page: rows, pagesFetched, isDone: true },
        });
        return rows;
      }

      const nextCursor = stringField(result, "continueCursor");
      if (!nextCursor || nextCursor === cursor) {
        throw new Error("Pagination did not return a new continueCursor");
      }
      cursor = nextCursor;
    }

    throw new Error(`Pagination exceeded the ${MAX_PAGES}-page safety limit`);
  } catch (error) {
    captures.push({
      label,
      query,
      args,
      status: "error",
      data:
        rows.length > 0
          ? { page: rows, pagesFetched, isDone: false }
          : undefined,
      error: errorMessage(error),
    });
    return rows;
  }
}

async function captureJsonBlob(
  captures: BlobCapture[],
  label: string,
  url: string,
): Promise<void> {
  try {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    captures.push({
      label,
      url,
      status: "ok",
      data: (await response.json()) as unknown,
    });
  } catch (error) {
    captures.push({
      label,
      url,
      status: "error",
      error: errorMessage(error),
    });
  }
}

async function mapWithConcurrency<T>(
  values: readonly T[],
  concurrency: number,
  task: (value: T, index: number) => Promise<void>,
): Promise<void> {
  let nextIndex = 0;
  const workers = Array.from(
    { length: Math.min(concurrency, values.length) },
    async () => {
      while (nextIndex < values.length) {
        const index = nextIndex;
        nextIndex += 1;
        await task(values[index]!, index);
      }
    },
  );
  await Promise.all(workers);
}

async function captureSessionDetails(args: {
  client: QueryClient;
  sessions: unknown[];
  queries: QueryCapture[];
  blobs: BlobCapture[];
  onProgress?: (completed: number, total: number) => void;
}): Promise<void> {
  let completed = 0;
  await mapWithConcurrency(
    args.sessions,
    SESSION_CONCURRENCY,
    async (session, index) => {
      const sessionId =
        stringField(session, "id") ?? stringField(session, "_id");
      if (!sessionId) {
        args.queries.push({
          label: `session[${index}]`,
          query: "chatSessions:getSession",
          args: {},
          status: "error",
          error: "Session list row did not include id or _id",
        });
        completed += 1;
        args.onProgress?.(completed, args.sessions.length);
        return;
      }

      const detail = await captureQuery(
        args.client,
        args.queries,
        `session:${sessionId}:detail`,
        "chatSessions:getSession",
        { sessionId },
      );
      const [
        snapshots,
        traces,
        artifacts,
        scores,
        checkRuns,
        historicalConfig,
      ] = await Promise.all([
        captureQuery(
          args.client,
          args.queries,
          `session:${sessionId}:widgetSnapshots`,
          "chatSessions:getWidgetSnapshots",
          { sessionId },
        ),
        captureQuery(
          args.client,
          args.queries,
          `session:${sessionId}:turnTraces`,
          "chatSessions:getSessionTurnTraces",
          { sessionId },
        ),
        captureQuery(
          args.client,
          args.queries,
          `session:${sessionId}:browserArtifacts`,
          "chatSessions:getBrowserArtifacts",
          { sessionId },
        ),
        captureQuery(
          args.client,
          args.queries,
          `session:${sessionId}:scores`,
          "sessionScores:listBySession",
          { sessionId },
        ),
        captureQuery(
          args.client,
          args.queries,
          `session:${sessionId}:checkRuns`,
          "chatSessionChecks:getCheckRunsForSession",
          { chatSessionId: sessionId },
        ),
        captureQuery(
          args.client,
          args.queries,
          `session:${sessionId}:historicalHostConfig`,
          "chatSessions:getSessionHistoricalHostConfig",
          { sessionId },
        ),
      ]);

      // Keep these referenced in the capture even when a backend returns an
      // unusual non-array shape; captureQuery already preserved the raw value.
      void snapshots;
      void artifacts;
      void scores;
      void checkRuns;
      void historicalConfig;

      const messagesBlobUrl = stringField(detail, "messagesBlobUrl");
      if (messagesBlobUrl) {
        await captureJsonBlob(
          args.blobs,
          `session:${sessionId}:messages`,
          messagesBlobUrl,
        );
      }

      await Promise.all(
        (Array.isArray(traces) ? traces : []).flatMap((trace, traceIndex) => {
          const spansBlobUrl = stringField(trace, "spansBlobUrl");
          return spansBlobUrl
            ? [
                captureJsonBlob(
                  args.blobs,
                  `session:${sessionId}:turn:${traceIndex}:spans`,
                  spansBlobUrl,
                ),
              ]
            : [];
        }),
      );

      completed += 1;
      args.onProgress?.(completed, args.sessions.length);
    },
  );
}

export async function collectRunRawData(
  client: QueryClient,
  scope: RawDataScope,
  onProgress?: (completed: number, total: number) => void,
): Promise<RunRawDataBundle> {
  const queries: QueryCapture[] = [];
  const blobs: BlobCapture[] = [];
  const notes = [
    "This bundle is assembled client-side from authorized Convex queries.",
    "Transcript, span, and topic-map JSON is resolved from temporary blob URLs; video and widget HTML remain represented by URL.",
    "A failed or undeployed query is preserved as an error entry instead of aborting the export.",
  ];
  let sessions: unknown[] = [];

  if (scope.kind === "swarm") {
    const perRunSessions = await Promise.all(
      scope.runIds.map(async (runId) => {
        await Promise.all([
          captureQuery(
            client,
            queries,
            `run:${runId}`,
            "journeyRuns:getJourneyRun",
            { runId },
          ),
          captureQuery(
            client,
            queries,
            `run:${runId}:scorecard`,
            "journeyRuns:getRunScorecard",
            { runId },
          ),
        ]);
        return capturePaginatedQuery(
          client,
          queries,
          `run:${runId}:sessions`,
          "journeyRuns:listSessionsByJourneyRun",
          { journeyRunId: runId },
        );
      }),
    );
    sessions = perRunSessions.flat();

    const topLevel = await Promise.all([
      captureQuery(
        client,
        queries,
        "swarm:sessionMetrics:projectScope",
        "journeyRuns:getSwarmSessionMetrics",
        { projectId: scope.projectId },
      ),
      captureQuery(
        client,
        queries,
        "swarm:usageBreakdown",
        "chatSessions:getSwarmUsageBreakdown",
        {
          projectId: scope.projectId,
          journeyRunIds: scope.runIds,
          filters: ALL_FILTERS,
        },
      ),
      captureQuery(
        client,
        queries,
        "swarm:topicMap",
        "chatSessions:getSwarmTopicMapSnapshot",
        { projectId: scope.projectId },
      ),
      captureQuery(
        client,
        queries,
        "swarm:findings:projectScope",
        "swarmWaveInsights:listSwarmFindings",
        { projectId: scope.projectId },
      ),
      scope.runIds[0]
        ? captureQuery(
            client,
            queries,
            "swarm:actionableInsights",
            "swarmWaveInsights:getJourneyRunInsightsEnvelope",
            { projectId: scope.projectId, runId: scope.runIds[0] },
          )
        : Promise.resolve(undefined),
      scope.swarmRunGroupId
        ? captureQuery(
            client,
            queries,
            "swarm:waveSignals",
            "swarmWaveInsights:getWaveSignals",
            {
              projectId: scope.projectId,
              swarmRunGroupId: scope.swarmRunGroupId,
            },
          )
        : Promise.resolve(undefined),
      scope.swarmRunGroupId
        ? captureQuery(
            client,
            queries,
            "swarm:waveInsights",
            "swarmWaveInsights:getWaveInsights",
            {
              projectId: scope.projectId,
              swarmRunGroupId: scope.swarmRunGroupId,
            },
          )
        : Promise.resolve(undefined),
    ]);

    const topicMap = topLevel[2];
    const topicMapBlobUrl = stringField(
      objectField(topicMap, "snapshot"),
      "topicMapBlobUrl",
    );
    if (topicMapBlobUrl) {
      await captureJsonBlob(blobs, "swarm:topicMapSnapshot", topicMapBlobUrl);
    }
    if (!scope.swarmRunGroupId) {
      notes.push(
        "This legacy swarm has no swarmRunGroupId, so wave signals and generated wave insights cannot be addressed.",
      );
    }
  } else {
    const [scenario, listedSessions, metrics, breakdown, topicMap, signals] =
      await Promise.all([
        captureQuery(
          client,
          queries,
          "scenario:settings",
          "scenarios:getScenario",
          { scenarioId: scope.scenarioId },
        ),
        captureQuery(
          client,
          queries,
          "scenario:sessions",
          "chatSessions:listByScenario",
          {
            scenarioId: scope.scenarioId,
            limit: 100,
            includeInternal: true,
            filters: ALL_FILTERS,
          },
        ),
        captureQuery(
          client,
          queries,
          "scenario:sessionMetrics",
          "chatSessions:getScenarioSessionMetrics",
          { scenarioId: scope.scenarioId },
        ),
        captureQuery(
          client,
          queries,
          "scenario:usageBreakdown",
          "chatSessions:getUsageBreakdown",
          { scenarioId: scope.scenarioId, filters: ALL_FILTERS },
        ),
        captureQuery(
          client,
          queries,
          "scenario:topicMap",
          "chatSessions:getTopicMapSnapshot",
          { scenarioId: scope.scenarioId },
        ),
        captureQuery(
          client,
          queries,
          "scenario:windowSignals",
          "scenarioWindowInsights:getWindowSignals",
          { scenarioId: scope.scenarioId },
        ),
        captureQuery(
          client,
          queries,
          "scenario:findings",
          "scenarioWindowInsights:listScenarioFindings",
          { scenarioId: scope.scenarioId },
        ),
        captureQuery(
          client,
          queries,
          "scenario:actionableInsights",
          "scenarioWindowInsights:getScenarioInsightsEnvelope",
          { scenarioId: scope.scenarioId },
        ),
      ]);
    void scenario;
    void metrics;
    void breakdown;
    sessions = Array.isArray(listedSessions) ? listedSessions : [];

    const latestGroupId = stringField(signals, "latestGroupId");
    if (latestGroupId) {
      await captureQuery(
        client,
        queries,
        "scenario:windowInsights",
        "scenarioWindowInsights:getWindowInsights",
        { scenarioId: scope.scenarioId, windowGroupId: latestGroupId },
      );
    } else {
      notes.push(
        "No latest window group exists, so generated User Testing window insights cannot be addressed yet.",
      );
    }

    const topicMapBlobUrl = stringField(
      objectField(topicMap, "snapshot"),
      "topicMapBlobUrl",
    );
    if (topicMapBlobUrl) {
      await captureJsonBlob(
        blobs,
        "scenario:topicMapSnapshot",
        topicMapBlobUrl,
      );
    }
    if (sessions.length >= 100) {
      notes.push(
        "The User Testing session query is capped at 100 rows by its current public contract; the bundle may omit older sessions.",
      );
    }
  }

  const detailSessions = sessions.slice(0, MAX_SESSION_DETAILS);
  if (sessions.length > detailSessions.length) {
    notes.push(
      `Per-session details were captured for the first ${detailSessions.length} of ${sessions.length} sessions; the session list itself is complete.`,
    );
  }
  await captureSessionDetails({
    client,
    sessions: detailSessions,
    queries,
    blobs,
    onProgress,
  });

  return {
    schemaVersion: 1,
    exportedAt: new Date().toISOString(),
    scope: scope.kind,
    scopeSnapshot: scope.snapshot,
    notes,
    queries,
    resolvedJsonBlobs: blobs,
  };
}

function downloadJson(value: RunRawDataBundle, fileName: string): void {
  const blob = new Blob([JSON.stringify(value, null, 2)], {
    type: "application/json",
  });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

export function RunRawDataPanel({ scope }: { scope: RawDataScope }) {
  const convex = useConvex() as unknown as QueryClient;
  const [bundle, setBundle] = useState<RunRawDataBundle | null>(null);
  const [loading, setLoading] = useState(false);
  const [progress, setProgress] = useState<{
    completed: number;
    total: number;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const requestIdRef = useRef(0);

  const load = useCallback(async () => {
    const requestId = ++requestIdRef.current;
    setLoading(true);
    setError(null);
    setProgress(null);
    try {
      const next = await collectRunRawData(
        convex,
        scope,
        (completed, total) => {
          if (requestId === requestIdRef.current) {
            setProgress({ completed, total });
          }
        },
      );
      if (requestId === requestIdRef.current) setBundle(next);
    } catch (loadError) {
      if (requestId === requestIdRef.current) {
        setError(errorMessage(loadError));
      }
    } finally {
      if (requestId === requestIdRef.current) setLoading(false);
    }
  }, [convex, scope]);

  const fileName =
    scope.kind === "swarm"
      ? `swarm-${
          scope.swarmRunGroupId ?? scope.runIds[0] ?? "run"
        }-raw-data.json`
      : `user-testing-${scope.scenarioId}-raw-data.json`;

  if (!bundle && !loading && !error) {
    return (
      <div
        className="flex h-full items-center justify-center px-6"
        data-testid="run-raw-data-empty"
      >
        <div className="max-w-xl rounded-xl border border-border/60 bg-muted/15 p-6 text-center">
          <Database className="mx-auto mb-3 size-7 text-muted-foreground" />
          <h2 className="text-sm font-semibold">
            Load the complete raw dataset
          </h2>
          <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
            This makes the run-level queries, loads every addressable session,
            and resolves transcript, trace-span, and topic-map JSON. The result
            may contain conversation content and temporary signed URLs, so it is
            excluded from session replay capture.
          </p>
          <Button
            type="button"
            size="sm"
            className="mt-4 rounded-lg"
            onClick={() => void load()}
            data-testid="run-raw-data-load"
          >
            Load raw data
          </Button>
        </div>
      </div>
    );
  }

  if (loading && !bundle) {
    return (
      <div
        className="flex h-full items-center justify-center text-sm text-muted-foreground"
        data-testid="run-raw-data-loading"
      >
        <Loader2 className="mr-2 size-4 animate-spin" />
        {progress
          ? `Loading session ${progress.completed} of ${progress.total}…`
          : "Loading run data…"}
      </div>
    );
  }

  if (error && !bundle) {
    return (
      <div className="flex h-full items-center justify-center px-6">
        <div className="max-w-lg text-center">
          <p className="text-sm text-destructive">{error}</p>
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="mt-3 rounded-lg"
            onClick={() => void load()}
          >
            Try again
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div
      className="ph-no-capture rr-block flex h-full min-h-0 flex-col gap-3 p-4"
      data-ph-no-capture
      data-testid="run-raw-data-panel"
    >
      <div className="flex shrink-0 items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-semibold">Raw query output</p>
          <p className="truncate text-xs text-muted-foreground">
            {bundle!.queries.length} query captures ·{" "}
            {bundle!.resolvedJsonBlobs.length} resolved JSON blobs
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="rounded-lg"
            disabled={loading}
            onClick={() => void load()}
          >
            {loading ? (
              <Loader2 className="mr-1.5 size-3.5 animate-spin" />
            ) : (
              <RefreshCw className="mr-1.5 size-3.5" />
            )}
            Refresh
          </Button>
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="rounded-lg"
            onClick={() => downloadJson(bundle!, fileName)}
            data-testid="run-raw-data-download"
          >
            <Download className="mr-1.5 size-3.5" />
            Download JSON
          </Button>
        </div>
      </div>
      {loading && progress ? (
        <p className="shrink-0 text-xs text-muted-foreground">
          Refreshing session {progress.completed} of {progress.total}…
        </p>
      ) : null}
      <div className="min-h-0 flex-1 overflow-hidden rounded-lg border border-border/60">
        <JsonEditor
          value={bundle}
          readOnly
          showModeToggle={false}
          allowMaximize
          collapsible
          defaultExpandDepth={2}
          collapseStringsAfterLength={2_000}
          height="100%"
          className="h-full rounded-none"
        />
      </div>
    </div>
  );
}
