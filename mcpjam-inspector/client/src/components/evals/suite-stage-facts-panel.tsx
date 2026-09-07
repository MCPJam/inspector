import { useMemo } from "react";
import { cn } from "@/lib/utils";
import { HOSTED_MODE } from "@/lib/config";
import { useHost } from "@/hooks/useClients";
import type { RemoteServer } from "@/hooks/useProjects";
import type { HostConfigDtoV2 } from "@/lib/client-config-v2";
import type { UserValueStage } from "@mcpjam/sdk/contract";
import {
  buildProjectEnvironmentPath,
  buildProjectServerPath,
  buildHostsPath,
  useAppNavigate,
} from "@/lib/app-navigation";
import {
  buildSuiteStageFacts,
  type StageFactLine,
  type StageFactLink,
  type StageFacts,
} from "./suite-stage-facts";

/**
 * One run target, as the Connection / Discovery cards describe it.
 *
 * `serverIds` is deliberately NOT resolved here: an environment that pins a
 * server group knows its ids up front, while one that uses the client's own
 * servers only learns them once the host config loads — which happens inside
 * this component's own `useHost`. So the caller says which of the two it is
 * and the child finishes the job.
 */
export type StageFactsTarget = {
  /** Stable across renders; React key and `data-stage-facts-target`. */
  key: string;
  label: string;
  /**
   * The client row this target runs as, or `""` when the config belongs to the
   * suite itself (an attachment-less suite) — there is no client page to link
   * to in that case, and no `hosts:getHost` to read.
   */
  hostId: string;
  /** Supplied instead of `hostId` for a suite-owned config. */
  hostConfig?: HostConfigDtoV2;
  environmentId?: string;
  attachment: { id: string; name: string } | null;
  servers:
    | { kind: "attachment"; ids: string[] }
    | { kind: "host"; extraIds: string[] };
};

function EditLink({
  link,
  children,
}: {
  link: StageFactLink;
  children: React.ReactNode;
}) {
  const navigate = useAppNavigate();
  const to =
    link.kind === "host"
      ? buildHostsPath(link.hostId)
      : link.kind === "environment"
        ? buildProjectEnvironmentPath(link.environmentId)
        : buildProjectServerPath(link.serverId);
  return (
    <button
      type="button"
      onClick={() => navigate(to)}
      className="shrink-0 text-[11px] text-muted-foreground underline underline-offset-2 hover:text-foreground"
    >
      {children}
    </button>
  );
}

function FactLines({ lines }: { lines: StageFactLine[] }) {
  return (
    <dl className="space-y-1">
      {lines.map((line) => (
        <div key={line.id} className="flex items-baseline gap-2 text-xs">
          <dt className="w-32 shrink-0 text-muted-foreground">{line.label}</dt>
          <dd className="min-w-0">
            <span
              className={cn(
                "break-words",
                line.tone === "attention"
                  ? "text-warning-foreground"
                  : line.tone === "empty"
                    ? "text-muted-foreground"
                    : "text-foreground",
              )}
            >
              {line.value}
            </span>
            {line.note ? (
              <span className="block text-[11px] text-muted-foreground">
                {line.note}
              </span>
            ) : null}
          </dd>
        </div>
      ))}
    </dl>
  );
}

function StageFactsBody({
  facts,
  label,
  environmentId,
}: {
  facts: StageFacts;
  label: string;
  environmentId?: string;
}) {
  if (facts.state === "loading") {
    return <p className="text-xs text-muted-foreground">{facts.message}</p>;
  }
  if (facts.state === "unavailable") {
    return (
      <div className="flex items-baseline justify-between gap-3">
        <p className="text-xs text-muted-foreground">{facts.message}</p>
        {facts.link ? <EditLink link={facts.link}>Open client</EditLink> : null}
      </div>
    );
  }
  return (
    <div className="space-y-3">
      <div className="flex items-baseline justify-between gap-3">
        <h4 className="min-w-0 truncate text-xs font-medium text-foreground">
          {label}
        </h4>
        <div className="flex shrink-0 items-baseline gap-3">
          {environmentId ? (
            <EditLink link={{ kind: "environment", environmentId }}>
              Open environment
            </EditLink>
          ) : null}
          {facts.hostLink.kind === "host" && facts.hostLink.hostId ? (
            <EditLink link={facts.hostLink}>Edit client</EditLink>
          ) : null}
        </div>
      </div>
      <FactLines lines={facts.hostLines} />
      {facts.servers.map((server) => (
        <div key={server.serverId} className="border-l border-border pl-3">
          <div className="flex items-baseline justify-between gap-3">
            <h5 className="min-w-0 truncate text-xs font-medium text-foreground">
              {server.name}
            </h5>
            {server.missing ? null : (
              <EditLink link={server.link}>Edit server</EditLink>
            )}
          </div>
          <div className="mt-1">
            <FactLines lines={server.lines} />
          </div>
        </div>
      ))}
    </div>
  );
}

function SuiteStageFactsTarget({
  stage,
  target,
  projectServers,
  isAuthenticated,
}: {
  stage: UserValueStage;
  target: StageFactsTarget;
  projectServers: RemoteServer[] | undefined;
  isAuthenticated: boolean;
}) {
  const { host, isLoading } = useHost({
    isAuthenticated,
    hostId: target.hostId || null,
  });

  // A suite-owned config arrives on the target; everything else comes from the
  // client row this target names.
  const resolvedHost = target.hostConfig ?? host?.config;
  const hostState = target.hostConfig
    ? ("ready" as const)
    : isLoading
      ? ("loading" as const)
      : host
        ? ("ready" as const)
        : ("missing" as const);

  const serverIds = useMemo(() => {
    if (target.servers.kind === "attachment") return target.servers.ids;
    const own = resolvedHost?.serverIds ?? [];
    return Array.from(new Set([...own, ...target.servers.extraIds]));
  }, [resolvedHost?.serverIds, target.servers]);

  const facts = useMemo(
    () =>
      buildSuiteStageFacts({
        hostId: target.hostId,
        hostName: host?.name,
        host: resolvedHost,
        hostState,
        serverIds,
        servers: projectServers,
        attachment: target.attachment,
        isHosted: HOSTED_MODE,
      }),
    [target, host, resolvedHost, hostState, serverIds, projectServers],
  );

  return (
    <div data-stage-facts-target={target.key}>
      <StageFactsBody
        facts={facts[stage === "connection" ? "connection" : "discovery"]}
        label={target.label}
        environmentId={target.environmentId}
      />
    </div>
  );
}

/**
 * The read-only facts under a runner-measured stage card.
 *
 * READ-ONLY by design. Every value here belongs to a client or a server row and
 * is shared with every other suite pointing at it — editing a timeout from a
 * suite page would silently change runs nobody on this page was thinking about.
 * So the card links out to where the value lives instead.
 *
 * Mounted once per stage, so a target with both cards open holds two
 * `useHost` subscriptions to the same id; Convex dedupes them.
 */
export function SuiteStageFactsList({
  stage,
  targets,
  projectServers,
  isAuthenticated,
  onGoToWhereItRuns,
  composeCapable,
}: {
  stage: UserValueStage;
  targets: StageFactsTarget[];
  projectServers: RemoteServer[] | undefined;
  isAuthenticated: boolean;
  onGoToWhereItRuns: () => void;
  composeCapable: boolean;
}) {
  if (targets.length === 0) {
    return (
      <div className="mt-3 flex items-baseline gap-2" data-stage-facts={stage}>
        <p className="text-xs text-muted-foreground">
          No run target yet — attach{" "}
          {composeCapable ? "an environment" : "a client"} under Where it runs.
        </p>
        <button
          type="button"
          onClick={onGoToWhereItRuns}
          className="text-[11px] text-muted-foreground underline underline-offset-2 hover:text-foreground"
        >
          Where it runs
        </button>
      </div>
    );
  }

  return (
    <div className="mt-3 space-y-4" data-stage-facts={stage}>
      {targets.map((target) => (
        <SuiteStageFactsTarget
          key={target.key}
          stage={stage}
          target={target}
          projectServers={projectServers}
          isAuthenticated={isAuthenticated}
        />
      ))}
    </div>
  );
}
