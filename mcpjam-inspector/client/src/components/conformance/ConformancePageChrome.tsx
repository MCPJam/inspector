/**
 * The Conformance page's frame: header with tabs and controls, the protocol
 * and server pickers, and the pre-run state.
 */

import { useId, useState, type ReactNode } from "react";
import { AlertTriangle, ChevronDown, Server } from "lucide-react";
import { Button } from "@mcpjam/design-system/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
} from "@mcpjam/design-system/select";
import { MCP_PROTOCOL_VERSIONS } from "@mcpjam/sdk/browser";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@mcpjam/design-system/popover";
import {
  ServerPickerServerList,
  type ServerPickerServerRow,
} from "@mcpjam/design-system/server-picker-panel";
import type { ServerWithName } from "@/hooks/use-app-state";
import {
  UNKNOWN_CONNECTION_STATUS,
  getConnectionStatusMeta,
  isConnectionStatus,
} from "@/components/connection/server-card-utils";
import { navigateApp, routePaths } from "@/lib/app-navigation";
import type { ProtocolVersionPin } from "@/hooks/use-conformance-run";
import { cn } from "@/lib/utils";
import { ConformanceScorePreview } from "./ConformanceScorePreview";

export const RUN_LABEL = "Run conformance checks";

export const NO_SERVERS_MESSAGE = "Add a server to run conformance checks.";

/**
 * The pre-run state: the sample score card above the first-run prompt and its
 * one Run button. It fills the space above whatever follows it in the scroll
 * container.
 */
export function ConformancePreRun({ runButton }: { runButton: ReactNode }) {
  return (
    // `my-auto` rather than `justify-center`: it centers the prompt while
    // there is room and, unlike justify-center, never clips the top once
    // the page scrolls.
    <div className="flex shrink-0 grow flex-col py-4">
      <div className="my-auto flex flex-col items-center gap-4">
        <ConformanceScorePreview />
        <div className="flex flex-col items-center gap-2 pt-6 text-center">
          <h3 className="text-xl font-semibold tracking-tight">
            Run your first conformance check
          </h3>
          <p className="text-sm text-muted-foreground">
            We assess protocol, apps, tasks, and OAuth on the server of your
            choice.
          </p>
          <div className="flex pt-6">{runButton}</div>
        </div>
      </div>
    </div>
  );
}

/**
 * A background connect that failed when Run was clicked: names the server and
 * offers the two ways forward, rather than a toast that is gone in seconds.
 */
export function ConformanceConnectError({
  server,
  needsSignIn,
  onRetry,
  onEdit,
}: {
  /** Only a name for a server this session has not loaded yet. */
  server: Pick<ServerWithName, "name"> &
    Partial<Pick<ServerWithName, "lastError" | "lastNormalizedError">>;
  needsSignIn: boolean;
  onRetry: () => void;
  onEdit?: () => void;
}) {
  const reason = needsSignIn
    ? "It needs you to sign in again."
    : (server.lastNormalizedError?.oneLine ??
      server.lastError ??
      "Check that it is running and that its server settings are right.");
  return (
    <div
      role="alert"
      className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-md border border-red-500/30 bg-red-500/5 px-4 py-3"
    >
      <div className="flex min-w-0 items-start gap-2 text-sm">
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-red-500" />
        <div className="min-w-0">
          <div className="font-medium">Couldn't connect to "{server.name}"</div>
          <div className="text-muted-foreground">{reason}</div>
        </div>
      </div>
      <div className="flex shrink-0 gap-2">
        {/* A plain retry would hit the same missing sign-in, so this one
            opens it. */}
        <Button size="sm" variant="outline" onClick={onRetry}>
          {needsSignIn ? "Sign in" : "Retry"}
        </Button>
        {onEdit ? (
          <Button size="sm" variant="ghost" onClick={onEdit}>
            Edit connection
          </Button>
        ) : null}
      </div>
    </div>
  );
}

export type ConformanceView = "overview" | "history";

const tabId = (view: ConformanceView) => `conformance-tab-${view}`;
const panelId = (view: ConformanceView) => `conformance-panel-${view}`;

/** The active view's content, labelled by its tab in the header. */
export function ConformanceTabPanel({
  view,
  children,
}: {
  view: ConformanceView;
  children: ReactNode;
}) {
  return (
    <div
      role="tabpanel"
      id={panelId(view)}
      aria-labelledby={tabId(view)}
      className="flex min-h-0 flex-1 flex-col"
    >
      {children}
    </div>
  );
}

/**
 * Title, Overview/History tabs and the page's controls (server picker,
 * protocol version, run). The controls arrive as children because the run
 * state lives in `ConformanceContent`, which only exists once a server is
 * picked.
 */
export function ConformanceHeader({
  view,
  onViewChange,
  showHistory,
  children,
}: {
  view: ConformanceView;
  onViewChange: (view: ConformanceView) => void;
  showHistory: boolean;
  children: ReactNode;
}) {
  const tabs: Array<{ id: ConformanceView; label: string }> = showHistory
    ? [
        { id: "overview", label: "Overview" },
        { id: "history", label: "History" },
      ]
    : [{ id: "overview", label: "Overview" }];

  return (
    <div className="shrink-0 border-b border-border/40 px-8 py-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="flex min-w-0 items-center gap-3">
          <h2 className="shrink-0 text-xl font-bold tracking-tight">
            Conformance
          </h2>
          <div className="h-4 w-px shrink-0 bg-border" />
          <div role="tablist" className="flex min-w-0 gap-1">
            {tabs.map((tab, index) => {
              const active = view === tab.id;
              return (
                <button
                  key={tab.id}
                  type="button"
                  role="tab"
                  id={tabId(tab.id)}
                  // Only the active view's panel is mounted; pointing the
                  // other tab at a missing id gives a screen reader a dead end.
                  aria-controls={active ? panelId(tab.id) : undefined}
                  aria-selected={active}
                  tabIndex={active ? 0 : -1}
                  onClick={() => onViewChange(tab.id)}
                  onKeyDown={(event) => {
                    const step =
                      event.key === "ArrowRight"
                        ? 1
                        : event.key === "ArrowLeft"
                          ? -1
                          : 0;
                    if (step === 0) return;
                    event.preventDefault();
                    const next =
                      tabs[(index + step + tabs.length) % tabs.length];
                    onViewChange(next.id);
                    document.getElementById(tabId(next.id))?.focus();
                  }}
                  className={cn(
                    "relative min-h-8 px-3.5 py-1 text-sm font-medium transition-colors",
                    active
                      ? "text-foreground"
                      : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  {tab.label}
                  {active && (
                    <span className="absolute inset-x-6 bottom-0 h-0.5 rounded-full bg-primary" />
                  )}
                </button>
              );
            })}
          </div>
        </div>
        <div className="flex items-center gap-2">{children}</div>
      </div>
      <p className="mt-2 max-w-2xl text-sm text-muted-foreground">
        Run protocol, apps, tasks, and OAuth checks against the server you pick.
      </p>
    </div>
  );
}

/**
 * Which MCP spec revision the protocol and OAuth suites test against. "Auto"
 * uses whatever version the server negotiates on `initialize`.
 */
export function ProtocolVersionSelect({
  value,
  onChange,
  disabled,
  labelledBy,
}: {
  value: ProtocolVersionPin;
  onChange?: (value: ProtocolVersionPin) => void;
  disabled?: boolean;
  /** The visible label's id; without one the select names itself. */
  labelledBy?: string;
}) {
  return (
    <Select
      value={value}
      onValueChange={(next) => onChange?.(next as ProtocolVersionPin)}
      disabled={disabled}
    >
      <SelectTrigger
        aria-label={labelledBy ? undefined : "Protocol version"}
        aria-labelledby={labelledBy}
        className="h-9.5 w-full justify-between gap-2 px-3 text-sm"
      >
        <span>Protocol · {value === "auto" ? "Auto" : value}</span>
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="auto">Auto (negotiated)</SelectItem>
        {/* Newest first: the revision most servers are moving to leads. */}
        {[...MCP_PROTOCOL_VERSIONS].reverse().map((version) => (
          <SelectItem key={version} value={version}>
            {version}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

/** How a server that is not connected reads in the picker; Run connects it. */
/**
 * A server's row in the picker: the status dot the server cards use, and a
 * Connect while it is neither connected nor on its way there.
 */
function serverRow(
  name: string,
  // A project server this session has not loaded is plainly not connected.
  status: string,
  onConnect: ((serverName: string) => void) | undefined,
  connecting: boolean,
): ServerPickerServerRow {
  // `isConnectionStatus`, not a cast: a value outside the union is a state
  // the page cannot read, so it gets no dot and no Connect.
  const meta = isConnectionStatus(status)
    ? getConnectionStatusMeta(status)
    : null;
  const inFlight =
    connecting ||
    status === "connected" ||
    status === "connecting" ||
    status === "oauth-flow";
  return {
    id: name,
    name,
    status: meta
      ? { label: meta.label, indicatorClassName: meta.indicatorClassName }
      : UNKNOWN_CONNECTION_STATUS,
    onConnect:
      onConnect && meta && !inFlight ? () => onConnect(name) : undefined,
  };
}

export function ConformanceServerPicker({
  servers,
  moreServerNames = [],
  loading = false,
  connectingNames = [],
  selectedName,
  onSelect,
  onConnect,
  labelledBy,
}: {
  servers: ServerWithName[];
  /** Project servers this session has not loaded, listed as not connected. */
  moreServerNames?: readonly string[];
  /** The project's servers are still loading. */
  loading?: boolean;
  /** Connects started here and not settled yet: no second Connect. */
  connectingNames?: readonly string[];
  selectedName: string | null;
  onSelect: (name: string) => void;
  /** Connects a server from its row. Omit to offer no Connect. */
  onConnect?: (serverName: string) => void;
  /** The visible label's id; without one the trigger names itself. */
  labelledBy?: string;
}) {
  const [open, setOpen] = useState(false);
  const valueId = useId();
  const loaded = new Set(servers.map((server) => server.name));
  const rows = [
    ...servers.map((server) =>
      serverRow(
        server.name,
        server.connectionStatus,
        onConnect,
        connectingNames.includes(server.name),
      ),
    ),
    ...moreServerNames
      .filter((name) => !loaded.has(name))
      .map((name) =>
        serverRow(
          name,
          "disconnected",
          onConnect,
          connectingNames.includes(name),
        ),
      ),
  ];
  const selected = rows.some((row) => row.name === selectedName)
    ? selectedName
    : null;
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={labelledBy ? undefined : "Server"}
          aria-labelledby={labelledBy ? `${labelledBy} ${valueId}` : undefined}
          className={cn(
            "flex h-8 max-w-[260px] items-center gap-1.5 rounded-full border px-2.5 text-foreground outline-none transition-colors",
            "focus-visible:ring-[3px] focus-visible:ring-ring/50",
            selected
              ? "border-border/60 bg-muted/40 hover:bg-muted/60"
              : "border-dashed border-border/60 bg-muted/30 hover:bg-muted/45",
          )}
        >
          <Server className="size-3.5 shrink-0 text-muted-foreground" />
          <span id={valueId} className="min-w-0 truncate text-xs font-medium">
            {selected ?? "Select server"}
          </span>
          <ChevronDown className="size-3 shrink-0 text-muted-foreground" />
        </button>
      </PopoverTrigger>
      <PopoverContent
        className="max-h-(--radix-popover-content-available-height) w-72 overflow-y-auto p-1.5"
        align="start"
        sideOffset={4}
      >
        <ServerPickerServerList
          servers={rows}
          selectedServerId={selected}
          catalogKnown={!loading || rows.length > 0}
          onSelectServer={(name) => {
            onSelect(name);
            setOpen(false);
          }}
          onAddServer={() => navigateApp(routePaths.servers)}
          // Conformance has no other way to add one, so it stays under the list.
          addServer="always"
        />
      </PopoverContent>
    </Popover>
  );
}
