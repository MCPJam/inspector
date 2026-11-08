import type { ReactNode } from "react";
import {
  ArrowLeft,
  ArrowRight,
  Cpu,
  Server,
  SlidersHorizontal,
  X,
} from "lucide-react";
import { Button } from "@mcpjam/design-system/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@mcpjam/design-system/popover";
import { Switch } from "@mcpjam/design-system/switch";

/**
 * The lane a pane's chat runs in, as its card composed it. A client pane with
 * plugins runs in a hidden environment; sections that read the pane's setup
 * (its Skills) use that id rather than composing another.
 */
export interface ComparePaneLane {
  /** The composed hidden environment, once ready; null when none is used. */
  environmentId: string | null;
  /** The lane wants a hidden environment that is still being composed. */
  pending: boolean;
}

/** A pane's header controls, rendered by its card with the card's lane. */
export type RenderComparePaneHeader = (lane: ComparePaneLane) => {
  actions?: ReactNode;
  summary?: ReactNode;
};

/** One labelled group in pane settings. Later sections (Skills) use it too. */
export function ComparePaneSettingsSection({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <section className="space-y-1.5">
      <h3 className="text-xs font-medium text-foreground">{title}</h3>
      {children}
    </section>
  );
}

export interface ComparePaneServer {
  /** Set for an environment's server, which is toggled by id. */
  id?: string;
  name: string;
  enabled: boolean;
}

/**
 * A Compare pane's settings, from the button in its header. Each control
 * changes only this pane: what it runs, its model and effort, which servers
 * it uses, and its place in the lineup. `children` adds sections for this
 * pane before the move controls.
 */
export function ComparePaneSettings({
  label,
  open,
  onOpenChange,
  target,
  model,
  effort,
  serverSource = "chat",
  servers,
  onServerChange,
  canMoveLeft,
  canMoveRight,
  onMove,
  children,
}: {
  /** The pane's client, for accessible names. */
  label: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** What the pane runs, with its section title. */
  target?: { title: string; control: ReactNode };
  /**
   * The pane's model picker, or the locked row of a runtime that picks.
   * Absent while the pane's target cannot run.
   */
  model?: ReactNode;
  effort?: ReactNode;
  /** The chat's servers, or an environment pane's own. */
  serverSource?: "chat" | "environment";
  /** Each server, marked on when this pane uses it. */
  servers: readonly ComparePaneServer[] | null;
  /** Called with the server's id when it has one, else its name. */
  onServerChange: (server: string, enabled: boolean) => void;
  canMoveLeft: boolean;
  canMoveRight: boolean;
  onMove: (offset: -1 | 1) => void;
  children?: ReactNode;
}) {
  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="size-7 shrink-0"
          aria-label={`Pane settings for ${label}`}
          data-testid="compare-pane-settings-trigger"
        >
          <SlidersHorizontal className="size-4" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        className="w-80 space-y-4"
        aria-label={`Pane settings for ${label}`}
        data-testid="compare-pane-settings"
      >
        <div className="flex items-center justify-between gap-2">
          <h2 className="text-sm font-semibold">Pane settings</h2>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-7"
            aria-label="Close pane settings"
            onClick={() => onOpenChange(false)}
          >
            <X className="size-4" />
          </Button>
        </div>
        {target ? (
          <ComparePaneSettingsSection title={target.title}>
            {target.control}
          </ComparePaneSettingsSection>
        ) : null}
        {model ? (
          <ComparePaneSettingsSection title="Model">
            {model}
            {effort}
          </ComparePaneSettingsSection>
        ) : null}
        {servers ? (
          <ComparePaneSettingsSection
            title={
              serverSource === "environment"
                ? "Servers in this environment"
                : "Servers for this chat"
            }
          >
            {servers.length === 0 ? (
              <p className="text-xs text-muted-foreground">
                {serverSource === "environment"
                  ? "This environment has no servers."
                  : "No servers in this chat. Add them with + in the composer."}
              </p>
            ) : (
              <ul className="space-y-1.5">
                {servers.map((server) => (
                  <li
                    key={server.id ?? server.name}
                    className="flex items-center justify-between gap-2 text-sm"
                  >
                    <span className="flex min-w-0 items-center gap-2">
                      <Server className="size-3.5 shrink-0 text-muted-foreground" />
                      <span className="truncate">{server.name}</span>
                    </span>
                    <Switch
                      checked={server.enabled}
                      onCheckedChange={(enabled) =>
                        onServerChange(server.id ?? server.name, enabled)
                      }
                      aria-label={`Use ${server.name} in ${label}`}
                    />
                  </li>
                ))}
              </ul>
            )}
          </ComparePaneSettingsSection>
        ) : null}
        {children}
        <div className="flex items-center gap-1 border-t border-border pt-3">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={!canMoveLeft}
            onClick={() => onMove(-1)}
          >
            <ArrowLeft className="size-3.5" />
            Move left
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={!canMoveRight}
            onClick={() => onMove(1)}
          >
            Move right
            <ArrowRight className="size-3.5" />
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}

/**
 * The line under a pane's header: the model it runs and what sets it apart,
 * so two panes on one client stay distinguishable on a narrow screen.
 */
export function ComparePaneSummary({
  modelName,
  details,
}: {
  modelName: string;
  /** Short facts in order, such as "Chosen by Cursor" or "2 servers". */
  details: readonly string[];
}) {
  return (
    <div
      data-testid="compare-pane-summary"
      className="flex min-w-0 flex-col gap-0.5 border-b border-border/60 px-3 py-1.5"
    >
      <span className="flex min-w-0 items-center gap-1.5 text-xs font-medium">
        <Cpu className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
        <span className="truncate">{modelName}</span>
      </span>
      {details.length > 0 ? (
        <span className="truncate text-[11px] text-muted-foreground">
          {details.join(" · ")}
        </span>
      ) : null}
    </div>
  );
}
