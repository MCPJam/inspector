/**
 * The Conformance page's frame: header with tabs and controls, the protocol
 * and server pickers, and the pre-run state.
 */

import type { ReactNode } from "react";
import { AlertTriangle, Server } from "lucide-react";
import { Button } from "@mcpjam/design-system/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@mcpjam/design-system/select";
import { MCP_PROTOCOL_VERSIONS } from "@mcpjam/sdk/browser";
import type { ServerWithName } from "@/hooks/use-app-state";
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
  server: ServerWithName;
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
function connectionNote(server: ServerWithName): string | null {
  switch (server.connectionStatus) {
    case "connected":
      return null;
    case "connecting":
    case "oauth-flow":
      return "Connecting";
    case "failed":
      return "Could not connect. Run to retry";
    default:
      return "Not connected";
  }
}

/** The page's own server picker; replaces the shell's header server tabs. */
export function ConformanceServerPicker({
  servers,
  selectedName,
  onSelect,
  labelledBy,
}: {
  servers: ServerWithName[];
  selectedName: string | null;
  onSelect: (name: string) => void;
  /** The visible label's id; without one the select names itself. */
  labelledBy?: string;
}) {
  const value =
    selectedName && servers.some((server) => server.name === selectedName)
      ? selectedName
      : undefined;
  const placeholder = servers.length === 0 ? "None" : "Select";
  return (
    <Select
      value={value}
      onValueChange={onSelect}
      disabled={servers.length === 0}
    >
      <SelectTrigger
        aria-label={labelledBy ? undefined : "Server"}
        aria-labelledby={labelledBy}
        className={cn(
          "h-8 w-auto max-w-[260px] gap-1.5 rounded-full px-2.5 text-xs font-medium shadow-none",
          value
            ? "border-border/60 bg-muted/40 hover:bg-muted/60"
            : "border-dashed border-border/60 bg-muted/30 hover:bg-muted/45",
        )}
      >
        <Server className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="min-w-0 truncate">
          <SelectValue placeholder={placeholder} />
        </span>
      </SelectTrigger>
      <SelectContent>
        {servers.map((server) => {
          const note = connectionNote(server);
          return (
            // The note goes in `description`, which stays in the menu: the
            // closed trigger repeats only the item text.
            <SelectItem
              key={server.name}
              value={server.name}
              description={note ?? undefined}
            >
              {server.name}
            </SelectItem>
          );
        })}
      </SelectContent>
    </Select>
  );
}
