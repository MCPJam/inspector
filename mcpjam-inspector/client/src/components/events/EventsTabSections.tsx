import { cn } from "@mcpjam/design-system/cn";
import { Radio } from "lucide-react";
import {
  describeModeRefusal,
  isEventDeliveryMode,
  type SubscribableModes,
} from "@mcpjam/sdk/browser";
import {
  EVENTS_DRAFT_DATE,
  EVENTS_DRAFT_SOURCE_URL,
} from "@/lib/events-profiles";

export function Section({
  title,
  description,
  actions,
  children,
}: {
  title: string;
  description?: React.ReactNode;
  actions?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="space-y-3 border-b border-border px-5 py-5 last:border-b-0">
      <header className="flex items-start justify-between gap-3">
        <div className="space-y-0.5">
          <h3 className="text-sm font-semibold text-foreground">{title}</h3>
          {description ? (
            <p className="text-xs text-muted-foreground">{description}</p>
          ) : null}
        </div>
        {actions}
      </header>
      {children}
    </section>
  );
}

/**
 * "Draft" is a label, not a gate (per the events plan): the extension is a
 * working-group draft pinned at one commit. The right side holds whatever the
 * pane wants beside it, such as the client the tab subscribes as.
 */
export function DraftHeader({
  title = "Events",
  children,
}: {
  title?: string;
  children?: React.ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2 border-b border-border px-5 py-3">
      <Radio className="h-4 w-4 text-muted-foreground" />
      <h2 className="text-sm font-semibold text-foreground">{title}</h2>
      <a
        href={EVENTS_DRAFT_SOURCE_URL}
        target="_blank"
        rel="noreferrer"
        className="rounded-sm border border-pending/40 bg-pending/10 px-1.5 py-0.5 text-[10px] font-medium text-foreground hover:underline"
        title={`MCP Events is a working-group draft. MCPJam implements its ${EVENTS_DRAFT_DATE} revision.`}
        data-testid="events-draft-badge"
      >
        Draft · {EVENTS_DRAFT_DATE}
      </a>
      {children ? (
        <div className="ml-auto flex items-center gap-2">{children}</div>
      ) : null}
    </div>
  );
}

/**
 * The delivery modes an event advertises, struck through where this client
 * or runtime can't use them, with the reason on hover.
 */
export function DeliveryChips({
  delivery,
  availability,
  hostName,
}: {
  delivery: string[];
  availability?: SubscribableModes;
  hostName: string;
}) {
  return (
    <div className="flex flex-wrap gap-1">
      {delivery.map((mode) => {
        const reason =
          availability && isEventDeliveryMode(mode)
            ? describeModeRefusal(mode, availability, hostName)
            : null;
        const usable =
          availability === undefined ||
          (isEventDeliveryMode(mode) && availability.modes.includes(mode));
        return (
          <span
            key={mode}
            className={cn(
              "rounded-sm border px-1.5 py-0.5 font-mono text-[10px]",
              usable
                ? "border-border bg-secondary text-secondary-foreground"
                : "border-border text-muted-foreground line-through",
            )}
            title={usable ? undefined : (reason ?? undefined)}
          >
            {mode}
          </span>
        );
      })}
    </div>
  );
}
