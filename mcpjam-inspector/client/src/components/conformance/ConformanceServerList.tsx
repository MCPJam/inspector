/**
 * The Conformance home once servers have runs: one card per server with its
 * latest result, suite scores, a link to that run, and a one-click Run.
 */

import { useEffect, useState } from "react";
import { useQuery } from "convex/react";
import { makeFunctionReference } from "convex/server";
import { Loader2 } from "lucide-react";
import { Button } from "@mcpjam/design-system/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
} from "@mcpjam/design-system/select";
import {
  isKnownProtocolVersion,
  MCP_PROTOCOL_VERSIONS,
  type McpProtocolVersion,
} from "@mcpjam/sdk/browser";
import type { ProtocolVersionPin } from "@/hooks/use-conformance-run";
import type { ServerWithName } from "@/hooks/use-app-state";
import { isHttpServer } from "@/hooks/conformance-suite-state";
import { useConformanceProtocolConnection } from "@/hooks/use-conformance-protocol-connection";
import { useArtifactQuery } from "@/lib/artifact-urls";
import { type ConformanceRunListItem } from "./ConformanceHistory";
import { RunResultRing } from "./RunResultRing";
import { SUITE_COPY, ServerAvatar } from "./conformance-ui";

const SUITES = ["protocol", "apps", "tasks", "oauth"] as const;
/** Four text-sm rows plus the gaps between them. */
const SUITE_STACK = "min-h-[6.875rem]";
const PROTOCOL_VERSIONS = [...MCP_PROTOCOL_VERSIONS].reverse();

const listRuns = makeFunctionReference<
  "query",
  {
    projectId: string;
    targetKey: string;
    protocolVersion: McpProtocolVersion;
    paginationOpts: { numItems: number; cursor: null };
  },
  { page: ConformanceRunListItem[] }
>("conformanceRuns:listRuns");

type SuiteReport = {
  suiteKind: string;
  status?: string;
  score: number | null;
  applicable?: number;
  passed?: number;
};

/** A suite with no score never ran, or every check was not applicable. */
function suiteRan(
  report: SuiteReport | undefined,
): report is SuiteReport & { applicable: number; passed: number } {
  return (
    report != null &&
    report.status !== "skipped" &&
    report.score != null &&
    typeof report.applicable === "number" &&
    report.applicable > 0 &&
    typeof report.passed === "number"
  );
}

function lastRunLabel(createdAt: number, now: number): string {
  const minutes = Math.max(0, Math.round((now - createdAt) / 60_000));
  if (minutes < 1) return "Last run just now";
  if (minutes < 60) return `Last run ${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `Last run ${hours}h ago`;
  const days = Math.round(hours / 24);
  return `Last run ${days}d ago`;
}

function SuiteMeter({
  report,
}: {
  report: SuiteReport & { applicable: number; passed: number };
}) {
  const title =
    SUITE_COPY[report.suiteKind as keyof typeof SUITE_COPY]?.title ??
    report.suiteKind;
  const width = Math.max(0, Math.min(100, report.score ?? 0));
  const [filled, setFilled] = useState(false);
  useEffect(() => {
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches) {
      setFilled(true);
      return;
    }
    let inner = 0;
    const frame = requestAnimationFrame(() => {
      inner = requestAnimationFrame(() => setFilled(true));
    });
    return () => {
      cancelAnimationFrame(frame);
      cancelAnimationFrame(inner);
    };
  }, []);
  return (
    <div className="flex items-center gap-3">
      <span className="w-16 shrink-0 text-sm">{title}</span>
      <span className="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-muted">
        <span
          className="block h-full rounded-full bg-success transition-[width] duration-700 ease-out motion-reduce:transition-none"
          style={{ width: filled ? `${width}%` : "0%" }}
        />
      </span>
      <span className="w-12 shrink-0 text-right text-sm tabular-nums text-muted-foreground">
        {report.passed}/{report.applicable}
      </span>
    </div>
  );
}

function ServerCard({
  server,
  run: latestRun,
  iconUrl,
  onViewRun,
  onRun,
  onSetup,
  disabled,
  starting,
}: {
  server: ServerWithName;
  run: ConformanceRunListItem;
  iconUrl?: string;
  onViewRun: (runId: string) => void;
  onRun: (
    serverName: string,
    version: ProtocolVersionPin,
    resolvedVersion?: McpProtocolVersion,
    previousVersion?: McpProtocolVersion,
  ) => void;
  onSetup: (serverName: string, version: McpProtocolVersion) => void;
  disabled: boolean;
  /** This card's Run was pressed and its run is being set up. */
  starting: boolean;
}) {
  const serverName = server.name;
  const [selection, setSelection] = useState<McpProtocolVersion | null>(null);
  const latestVersion = latestRun.protocolVersion;
  const selectedVersion = selection ?? latestVersion;
  const knownLatest = latestVersion && isKnownProtocolVersion(latestVersion);
  const pin = selection ?? (knownLatest ? latestVersion : "auto");
  // Check an explicitly chosen revision without probing every server on load.
  const connection = useConformanceProtocolConnection(
    selection ? server : undefined,
    pin,
  );
  const connectionResult = connection.result;
  const unsupported = connectionResult?.status === "unsupported";
  const [refused, setRefused] = useState<{
    config: ServerWithName["config"];
    connectedAt: ServerWithName["lastConnectionTime"];
    tokens: ServerWithName["oauthTokens"];
    versions: ReadonlySet<McpProtocolVersion>;
  }>();
  const refusedVersions =
    refused &&
    refused.config === server.config &&
    refused.connectedAt === server.lastConnectionTime &&
    refused.tokens === server.oauthTokens
      ? refused.versions
      : undefined;
  // A reply can name only the version it negotiated. Hide each revision
  // the server explicitly refuses, and allow a fresh check after reconnecting.
  if (unsupported && selection && !refusedVersions?.has(selection)) {
    setRefused({
      config: server.config,
      connectedAt: server.lastConnectionTime,
      tokens: server.oauthTokens,
      versions: new Set([...(refusedVersions ?? []), selection]),
    });
  }
  const refusalMessage = unsupported ? (
    <>
      {serverName} doesn’t support {connectionResult.protocolVersion}.{" "}
      {connectionResult.supportedVersions.length > 0
        ? `Server offers: ${connectionResult.supportedVersions.join(", ")}.`
        : "Choose another protocol version."}
    </>
  ) : null;
  const retry = connectionResult?.status === "failed";
  const needsSetup =
    selection !== null &&
    (server.connectionStatus !== "connected" ||
      connectionResult?.status === "auth-required");
  const runLabel = retry ? "Retry" : needsSetup ? "Set up run" : "Run";
  const resolvedVersion =
    connectionResult?.status === "ready"
      ? connectionResult.protocolVersion
      : undefined;
  const showLatest = selection === null || selection === latestVersion;
  const byVersion = useQuery(
    listRuns,
    !showLatest
      ? {
          projectId: latestRun.projectId,
          targetKey: latestRun.targetKey,
          protocolVersion: selection,
          paginationOpts: { numItems: 1, cursor: null },
        }
      : "skip",
  );
  const run = showLatest ? latestRun : byVersion?.page[0];
  const loading = !showLatest && byVersion === undefined;
  const handleRun = () => {
    if (retry) connection.retry();
    else if (needsSetup) onSetup(serverName, selection);
    else
      onRun(
        serverName,
        pin,
        resolvedVersion,
        !run && knownLatest && isHttpServer(server) ? latestVersion : undefined,
      );
  };
  const detail = useArtifactQuery<{ reports?: SuiteReport[] } | null>(
    "conformanceRuns:getRun",
    run ? { runId: run._id } : "skip",
  );
  const reports = new Map(
    (detail?.reports ?? []).map((report) => [report.suiteKind, report]),
  );
  const suites = SUITES.flatMap((kind) => {
    const report = reports.get(kind);
    return suiteRan(report) ? [report] : [];
  });
  const percent = run?.score == null ? "—" : `${Math.round(run.score)}%`;
  // Query updates do not tick with the clock, so "Last run 2m ago" would go
  // stale on an open page without this.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(id);
  }, []);

  return (
    <li className="flex h-full flex-col gap-4 rounded-lg bg-popover px-5 py-4 text-popover-foreground shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
        <div className="flex min-w-0 items-center gap-3">
          <ServerAvatar name={serverName} iconUrl={iconUrl} className="size-9" />
          <span className="truncate text-[15px] font-semibold">
            {serverName}
          </span>
        </div>
        <Select
          value={pin}
          onValueChange={(value) =>
            setSelection(isKnownProtocolVersion(value) ? value : null)
          }
        >
          <SelectTrigger
            size="sm"
            aria-label={`Protocol version for ${serverName}`}
          >
            <span>Protocol · {selectedVersion ?? "Auto"}</span>
          </SelectTrigger>
          <SelectContent>
            {!knownLatest && (
              <SelectItem value="auto">{latestVersion ?? "Auto"}</SelectItem>
            )}
            {PROTOCOL_VERSIONS.filter(
              (version) => !refusedVersions?.has(version),
            ).map((version) => (
              <SelectItem key={version} value={version}>
                {version}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      {run ? (
        <div key={run._id} className="mb-2 flex items-center gap-5">
          <div className="flex w-[88px] shrink-0 items-center justify-center">
            <RunResultRing run={run} size={88} label={percent} animate />
          </div>
          <div
            className={`flex ${SUITE_STACK} min-w-0 flex-1 flex-col justify-center gap-2.5`}
            role="group"
            aria-label={`${serverName} suites`}
          >
            {suites.map((report) => (
              <SuiteMeter key={report.suiteKind} report={report} />
            ))}
          </div>
        </div>
      ) : (
        <p
          role="status"
          className={`mb-2 flex ${SUITE_STACK} items-center justify-center text-center text-sm text-muted-foreground`}
        >
          {refusalMessage ??
            (loading
              ? "Loading latest run…"
              : "Clients can connect on any version your server supports. Run this one to make sure it passes too.")}
        </p>
      )}
      {run && refusalMessage && (
        <p role="status" className="text-sm text-muted-foreground">
          {refusalMessage}
        </p>
      )}
      {retry && (
        <p role="status" className="text-sm text-muted-foreground">
          Couldn’t check this protocol version. Try again.
        </p>
      )}
      <div className="mt-auto flex flex-wrap items-center justify-between gap-3">
        <span className="text-sm text-muted-foreground">
          {run && lastRunLabel(run.createdAt, now)}
        </span>
        <div className="flex shrink-0 items-center gap-2">
          {run && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => onViewRun(run._id)}
            >
              View last run
            </Button>
          )}
          <Button
            size="sm"
            disabled={
              disabled ||
              starting ||
              loading ||
              connection.checking ||
              unsupported
            }
            onClick={handleRun}
            aria-label={
              starting ? `Starting ${serverName}` : `${runLabel} ${serverName}`
            }
            aria-busy={starting || connection.checking || undefined}
          >
            {starting ? (
              <>
                <Loader2
                  className="mr-1.5 h-3.5 w-3.5 animate-spin"
                  aria-hidden
                />
                Starting...
              </>
            ) : (
              connection.checking ? "Checking version..." : runLabel
            )}
          </Button>
        </div>
      </div>
    </li>
  );
}

export function ConformanceServerList({
  runs,
  serverIcons,
  onViewRun,
  onRun,
  onSetup,
  disabled = false,
  disabledServerName,
  startingServerName,
}: {
  /** Each server's latest run, by server name. */
  runs: Array<{ server: ServerWithName; run: ConformanceRunListItem }>;
  /** Each server's logo URL, by name; initials where there is none. */
  serverIcons?: Record<string, string>;
  onViewRun: (runId: string) => void;
  onRun: Parameters<typeof ServerCard>[0]["onRun"];
  onSetup: Parameters<typeof ServerCard>[0]["onSetup"];
  /** A run is connecting, or the saved defaults are still loading. */
  disabled?: boolean;
  /** The server whose saved defaults could not be loaded. */
  disabledServerName?: string;
  /**
   * The server whose Run was pressed, while its run is set up. Every Run
   * stays off meanwhile (a second Run would replace this one), so this card
   * says which one is starting.
   */
  startingServerName?: string;
}) {
  return (
    <ul
      className="grid grid-cols-1 items-stretch gap-4 md:grid-cols-2"
      aria-label="Servers"
    >
      {runs.map(({ server, run }) => (
        <ServerCard
          key={`${run.projectId}/${run.targetKey}`}
          server={server}
          run={run}
          iconUrl={serverIcons?.[server.name]}
          onViewRun={onViewRun}
          onRun={onRun}
          onSetup={onSetup}
          disabled={disabled || disabledServerName === server.name}
          starting={startingServerName === server.name}
        />
      ))}
    </ul>
  );
}
