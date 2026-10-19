/**
 * The Conformance page's frame: header with tabs and controls, the protocol
 * and server pickers, and the pre-run state.
 */

import type { ReactNode } from "react";
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

/** The pre-run page: the animated score card above the first-run prompt. */
export function ConformancePreRun({ runButton }: { runButton: ReactNode }) {
  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-4 overflow-y-auto px-8 py-10">
      <ConformanceScorePreview />
      <div className="flex flex-col items-center gap-2 pt-2 text-center">
        <h3 className="text-xl font-semibold tracking-tight">
          Run your first conformance check
        </h3>
        <p className="text-sm text-muted-foreground">
          We assess protocol, apps, tasks, and OAuth on the server of your
          choice.
        </p>
        <div className="pt-4">{runButton}</div>
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
}: {
  value: ProtocolVersionPin;
  onChange?: (value: ProtocolVersionPin) => void;
  disabled?: boolean;
}) {
  return (
    <Select
      value={value}
      onValueChange={(next) => onChange?.(next as ProtocolVersionPin)}
      disabled={disabled}
    >
      <SelectTrigger
        aria-label="Protocol version"
        className="h-8 w-auto gap-2 text-sm"
      >
        <span>Protocol · {value === "auto" ? "Auto" : value}</span>
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
  );
}

/** The page's own server picker; replaces the shell's header server tabs. */
export function ConformanceServerPicker({
  servers,
  selectedName,
  onSelect,
}: {
  servers: ServerWithName[];
  selectedName: string | null;
  onSelect: (name: string) => void;
}) {
  const value =
    selectedName && servers.some((server) => server.name === selectedName)
      ? selectedName
      : undefined;
  return (
    <Select
      value={value}
      onValueChange={onSelect}
      disabled={servers.length === 0}
    >
      <SelectTrigger aria-label="Server" className="h-8 w-auto gap-2 text-sm">
        <SelectValue
          placeholder={
            servers.length === 0 ? "No connected servers" : "Select a server"
          }
        />
      </SelectTrigger>
      <SelectContent>
        {servers.map((server) => (
          <SelectItem key={server.name} value={server.name}>
            {server.name}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
