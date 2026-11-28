import { useEffect, useMemo, useState } from "react";
import { useQuery } from "convex/react";
import { makeFunctionReference } from "convex/server";
import { Loader2, PanelLeft, Search } from "lucide-react";
import { Badge } from "@mcpjam/design-system/badge";
import { Button } from "@mcpjam/design-system/button";
import { Input } from "@mcpjam/design-system/input";
import { ScrollArea } from "@mcpjam/design-system/scroll-area";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@mcpjam/design-system/select";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from "@mcpjam/design-system/sheet";
import { Tooltip, TooltipContent, TooltipTrigger } from "@mcpjam/design-system/tooltip";
import { SessionListChrome } from "@/components/connection/share-usage/ShareUsageThreadList";
import { ErrorBoundary } from "@/components/ui/error-boundary";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable";
import { shouldQueryProjectId } from "@/hooks/useProjects";
import { useProjectEnvironmentsEnabled } from "@/hooks/useProjectEnvironmentsEnabled";
import { SWARM_QUERIES, type SwarmOverview } from "@/lib/swarm-api";
import { cn } from "@/lib/utils";
import { SwarmsEmptyHero } from "./swarms-empty-hero";
import type { FindingsPersonaDoc } from "./findings/findings-derivation";
import { PersonaPixelAvatar } from "./persona-pixel-avatar";
import { SwarmOverviewReport } from "./swarm-overview-report";
import { describeSwarmIdentity } from "./swarm-run-header";
import {
  findingName,
  groupRunsIntoSwarmWaves,
  swarmWaveRouteId,
  waveClientNames,
  waveEnvironmentNames,
  waveRunState,
  waveSessionTotals,
  waveTargets,
  WaveClientLogoStrip,
  type SwarmWave,
} from "./swarm-overview-panel";

const overviewQuery = makeFunctionReference<"query", { projectId: string }, SwarmOverview>(
  SWARM_QUERIES.getSwarmOverview,
);

type PanelProps = {
  projectId: string | null;
  hosts?: readonly { name: string; hostStyle?: string | null }[];
  personas: readonly FindingsPersonaDoc[] | undefined;
  selectedId?: string;
  onSelectRun: (id: string) => void;
  onNewSwarm: () => void;
  onOpenSwarm: (swarmId: string) => void;
};

function NoRuns() {
  return (
    <div
      className="flex min-h-0 flex-1 items-center justify-center px-6 text-center"
      data-testid="swarm-overview-no-runs"
    >
      <div className="max-w-sm space-y-1.5">
        <h3 className="text-sm font-semibold">No runs yet</h3>
        <p className="text-xs text-muted-foreground">Open Personas and run one of your goals.</p>
      </div>
    </div>
  );
}

export function SwarmOverviewPanel(props: PanelProps) {
  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="swarms-overview-panel">
      <ErrorBoundary key={props.projectId} fallback={<NoRuns />}>
        {props.personas?.length === 0 ? (
          <SwarmsEmptyHero onNewSwarm={props.onNewSwarm} />
        ) : (
          <OverviewBody {...props} />
        )}
      </ErrorBoundary>
    </div>
  );
}

function OverviewBody({ projectId, personas, hosts, selectedId, onSelectRun, onOpenSwarm }: PanelProps) {
  const overview = useQuery(
    overviewQuery,
    shouldQueryProjectId(projectId) && projectId ? { projectId } : "skip",
  );
  const waves = useMemo(() => groupRunsIntoSwarmWaves(overview?.runs ?? []), [overview]);

  if (!projectId || !overview || !personas)
    return (
      <div
        className="flex min-h-0 flex-1 items-center justify-center gap-2 text-sm text-muted-foreground"
        data-testid="swarm-overview-loading"
      >
        <Loader2 className="size-4 animate-spin" aria-hidden /> Loading overview…
      </div>
    );
  if (waves.length === 0) return <NoRuns />;
  return (
    <RunWorkspace
      projectId={projectId}
      waves={waves}
      personas={personas}
      hosts={hosts}
      selectedId={selectedId}
      onSelectRun={onSelectRun}
      onOpenSwarm={onOpenSwarm}
    />
  );
}

function describeWave(wave: SwarmWave) {
  const { name, formattedDate, ...identity } = describeSwarmIdentity(wave);
  const targets = waveTargets(wave.runs);
  const personas = [...new Set(wave.runs.map((run) => run.personaName))];
  return {
    wave,
    targets,
    ...identity,
    personas,
    id: swarmWaveRouteId(wave),
    clients: waveClientNames(targets),
    environments: waveEnvironmentNames(targets),
    totals: waveSessionTotals(wave.runs),
    words: [
      name,
      formattedDate,
      ...identity.servers,
      ...personas,
      ...wave.runs.flatMap((run) => [run.journeyName, ...run.findings.map(findingName)]),
    ]
      .join(" ")
      .toLocaleLowerCase(),
  };
}

export type OverviewWave = ReturnType<typeof describeWave>;

function OverviewFilter({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: string[];
  onChange: (value: string) => void;
}) {
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger aria-label={label} className="min-w-0 max-w-full bg-card">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="all">{label}</SelectItem>
        {options.map((name) => (
          <SelectItem key={name} value={`name:${name}`}>
            {name}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function RunWorkspace({
  projectId,
  waves,
  hosts,
  personas,
  selectedId,
  onSelectRun,
  onOpenSwarm,
}: {
  projectId: string;
  waves: SwarmWave[];
  hosts: PanelProps["hosts"];
  personas: readonly FindingsPersonaDoc[];
  selectedId?: string;
  onSelectRun: PanelProps["onSelectRun"];
  onOpenSwarm: PanelProps["onOpenSwarm"];
}) {
  const environmentsEnabled = useProjectEnvironmentsEnabled();
  const [search, setSearch] = useState("");
  const [server, setServer] = useState("all");
  const [client, setClient] = useState("all");
  const [environment, setEnvironment] = useState("all");
  const [historyOpen, setHistoryOpen] = useState(false);
  const rows = useMemo(() => waves.map(describeWave), [waves]);
  const hostStyleByName = useMemo(
    () => new Map(hosts?.map((host) => [host.name.trim(), host.hostStyle])),
    [hosts],
  );

  useEffect(() => {
    if (!historyOpen || !window.matchMedia) return;
    const desktop = window.matchMedia("(min-width: 1024px)");
    const closeOnDesktop = () => {
      if (desktop.matches) setHistoryOpen(false);
    };
    desktop.addEventListener("change", closeOnDesktop);
    return () => desktop.removeEventListener("change", closeOnDesktop);
  }, [historyOpen]);

  const filters = ([
    { field: "servers", value: server, onChange: setServer },
    { field: "clients", value: client, onChange: setClient },
    { field: "environments", value: environment, onChange: setEnvironment },
  ] as const)
    .filter(({ field }) => environmentsEnabled || field !== "environments")
    .map((filter) => ({
      ...filter,
      names: [...new Set(rows.flatMap((row) => row[filter.field]))].sort((a, b) =>
        a.localeCompare(b),
      ),
    }));
  const query = search.trim().toLocaleLowerCase();
  const visible = rows.filter(
    (row) =>
      row.words.includes(query) &&
      filters.every(
        ({ field, names, value }) =>
          value === "all" || !names.includes(value.slice(5)) || row[field].includes(value.slice(5)),
      ),
  );
  const active = visible.find((row) => row.id === selectedId) ?? visible[0];
  const select = (id: string) => {
    onSelectRun(id);
    setHistoryOpen(false);
  };
  const historyProps = {
    rows: visible,
    activeId: active?.id,
    onSelect: select,
    personas,
    hostStyleByName,
  };

  const openSwarm = (id: string) => {
    onSelectRun(id);
    onOpenSwarm(id);
  };

  const report = active ? (
    <ErrorBoundary
      key={active.id}
      fallback={
        <div className="space-y-3 px-4 py-6">
          <p className="text-sm text-muted-foreground">
            Couldn't load the report. Open the full swarm to view this run.
          </p>
          <Button variant="outline" size="sm" onClick={() => openSwarm(active.id)}>
            Open full swarm
          </Button>
        </div>
      }
    >
      <SwarmOverviewReport
        row={active}
        projectId={projectId}
        personas={personas}
        hostStyleByName={hostStyleByName}
        showEnvironment={environmentsEnabled}
        onOpenSwarm={openSwarm}
      />
    </ErrorBoundary>
  ) : (
    <div
      className="flex h-full flex-col items-center justify-center gap-3 p-4 text-center"
      data-testid="swarm-overview-filter-empty"
    >
      <p role="status" className="text-sm text-muted-foreground">
        No matching runs.
      </p>
      <Button
        size="sm"
        variant="outline"
        onClick={() => {
          setSearch("");
          setServer("all");
          setClient("all");
          setEnvironment("all");
        }}
      >
        Clear filters
      </Button>
    </div>
  );

  return (
    <section
      className="flex min-h-0 flex-1 flex-col gap-3 px-3 py-3 sm:px-6"
      data-testid="swarm-overview-runs"
    >
      <div className="flex flex-col gap-2 sm:flex-row" data-testid="swarm-overview-filters">
        <div className="relative min-w-0 flex-1">
          <Search
            aria-hidden
            className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
          />
          <Input
            type="search"
            aria-label="Search runs"
            placeholder="Search servers, personas, findings…"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            className="h-9 bg-card pl-9"
          />
        </div>
        <div className="flex min-w-0 flex-wrap gap-2 sm:max-w-[65%]">
          {filters
            .filter((filter) => filter.names.length > 0)
            .map((filter) => (
              <OverviewFilter
                key={filter.field}
                label={`All ${filter.field}`}
                options={filter.names}
                value={filter.names.includes(filter.value.slice(5)) ? filter.value : "all"}
                onChange={filter.onChange}
              />
            ))}
        </div>
        <Sheet open={historyOpen} onOpenChange={setHistoryOpen}>
          <SheetTrigger asChild>
            <Button size="sm" variant="outline" className="self-start lg:hidden">
              <PanelLeft aria-hidden /> Run history
            </Button>
          </SheetTrigger>
          <SheetContent
            aria-describedby={undefined}
            side="left"
            className="w-[min(90vw,24rem)] gap-0 p-0"
          >
            <SheetHeader className="border-b">
              <SheetTitle>Run history</SheetTitle>
            </SheetHeader>
            <History {...historyProps} inSheet />
          </SheetContent>
        </Sheet>
      </div>
      <div className="min-h-0 flex-1 overflow-hidden rounded-xl border">
        <ResizablePanelGroup direction="horizontal">
          <ResizablePanel
            id="swarm-history"
            defaultSize={32}
            minSize={26}
            maxSize={45}
            className="max-lg:hidden"
          >
            <History {...historyProps} />
          </ResizablePanel>
          <ResizableHandle withHandle className="max-lg:hidden" />
          <ResizablePanel id="swarm-report" minSize={55} className="max-lg:flex-1!">
            {report}
          </ResizablePanel>
        </ResizablePanelGroup>
      </div>
    </section>
  );
}

function History({
  rows,
  activeId,
  onSelect,
  personas,
  hostStyleByName,
  inSheet,
}: {
  rows: OverviewWave[];
  activeId?: string;
  onSelect: (id: string) => void;
  personas: readonly FindingsPersonaDoc[];
  hostStyleByName: ReadonlyMap<string, string | null | undefined>;
  inSheet?: boolean;
}) {
  return (
    <aside
      aria-label="Run history"
      className="flex min-h-0 flex-1 flex-col bg-card text-card-foreground lg:h-full"
    >
      {!inSheet && <SessionListChrome countLabel="Run history" />}
      <ScrollArea className="min-h-0 flex-1 [&_[data-slot=scroll-area-viewport]>div]:block!">
        {rows.length === 0 && <p className="p-4 text-sm text-muted-foreground">No matching runs.</p>}
        {rows.map((row) => (
          <button
            type="button"
            key={row.wave.waveId}
            aria-pressed={row.id === activeId}
            onClick={() => onSelect(row.id)}
            data-testid="swarm-overview-run-row"
            data-wave-id={row.wave.waveId}
            className={cn(
              "flex w-full min-w-0 flex-col gap-2 border-b border-l-2 px-3 py-3 text-left focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring",
              row.id === activeId
                ? "border-l-primary bg-muted"
                : "border-l-transparent hover:bg-muted/50",
            )}
          >
            <span className="flex w-full items-center gap-2">
              <span className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-2 gap-y-0.5">
                <span className="max-w-full truncate text-sm font-semibold" title={row.heading}>
                  {row.heading}
                </span>
                {row.date && <span className="shrink-0 text-sm text-foreground/75">{row.date}</span>}
                <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                  {row.totals.succeeded} {row.totals.succeeded === 1 ? "session" : "sessions"}
                </span>
                {waveRunState(row.wave.runs) === "running" && (
                  <span className="text-xs text-muted-foreground">Running</span>
                )}
              </span>
              {row.clients.length > 0 && (
                <WaveClientLogoStrip targets={row.targets} hostStyleByName={hostStyleByName} />
              )}
            </span>
            {row.title && (
              <span className="max-w-full truncate text-sm text-muted-foreground">{row.title}</span>
            )}
            <PersonaPills names={row.personas} personas={personas} />
          </button>
        ))}
      </ScrollArea>
    </aside>
  );
}

function PersonaPills({
  names,
  personas,
}: {
  names: readonly string[];
  personas: readonly FindingsPersonaDoc[];
}) {
  const hidden = names.slice(2);
  return (
    <span className="flex w-full min-w-0 items-center gap-1.5">
      {names.slice(0, 2).map((name) => {
        const persona = personas.find((item) => item.name === name);
        return (
          <Badge
            key={name}
            variant="outline"
            title={name}
            className="h-6 min-w-0 shrink justify-start gap-1 rounded-full bg-background py-0 pr-2 pl-1 font-normal"
          >
            <PersonaPixelAvatar
              seed={persona?._id ?? name}
              shapeIndex={persona?.avatarShape}
              paletteIndex={persona?.avatarPalette}
              size="sm"
              className="size-5! animate-none [&>svg]:size-5"
            />
            <span className="min-w-0 truncate">{name}</span>
          </Badge>
        );
      })}
      {hidden.length > 0 && (
        <Tooltip>
          <TooltipTrigger asChild>
            <Badge
              variant="outline"
              className="h-6 rounded-full bg-background px-1.5 text-muted-foreground"
            >
              <span aria-hidden>+{hidden.length}</span>
              <span className="sr-only">{hidden.join(", ")}</span>
            </Badge>
          </TooltipTrigger>
          <TooltipContent variant="muted">{hidden.join(", ")}</TooltipContent>
        </Tooltip>
      )}
    </span>
  );
}
