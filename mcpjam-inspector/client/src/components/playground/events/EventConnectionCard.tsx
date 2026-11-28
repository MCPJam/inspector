import { useState } from "react";
import { ChevronDown, Radio } from "lucide-react";
import { Button } from "@mcpjam/design-system/button";
import { cn } from "@mcpjam/design-system/cn";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@mcpjam/design-system/collapsible";
import { ReachabilityHeader } from "@/components/events/ReachabilityHeader";
import { hasInsecureLocalReceiver } from "@/components/events/event-utils";
import { eventTime, outcomeLabel } from "./recent-events";
import type { PlaygroundEventBinding } from "./PlaygroundEventsProvider";

/**
 * One connection in the Playground Events pane. Closed, it says what the
 * connection is doing and when it last fired. Open, it lists recent events and
 * the connection's actions. A problem shows either way.
 */
export function EventConnectionCard({
  binding,
  status,
  connected,
  hosted,
  onTrigger,
  onEdit,
  onTogglePause,
}: {
  binding: PlaygroundEventBinding;
  status: string;
  connected: boolean;
  hosted: boolean;
  onTrigger: () => void;
  onEdit: () => void;
  onTogglePause: () => void;
}) {
  const [open, setOpen] = useState(false);
  const events = binding.recentEvents ?? [];
  const latest = events[0];
  const problem =
    binding.notice ??
    (latest?.outcome && latest.outcome.status !== "sent"
      ? latest.outcome.message
      : undefined);
  return (
    <Collapsible open={open} onOpenChange={setOpen} asChild>
      <section
        className="space-y-2 rounded-md border border-border p-3"
        aria-label={`${binding.eventName} connection`}
      >
        <CollapsibleTrigger className="flex w-full items-start gap-2 text-left">
          <span className="min-w-0 flex-1 space-y-2">
            {binding.title ? (
              <span className="block truncate text-xs font-medium">
                {binding.title}
              </span>
            ) : null}
            <span className="flex items-center gap-2">
              <Radio className="size-3.5 shrink-0 text-muted-foreground" />
              <span className="truncate font-mono text-xs">
                {binding.eventName}
              </span>
            </span>
          </span>
          <ChevronDown
            aria-hidden
            className={cn(
              "mt-0.5 size-3.5 shrink-0 text-muted-foreground transition-transform",
              open && "rotate-180",
            )}
          />
        </CollapsibleTrigger>
        <p className="text-xs text-muted-foreground">
          {binding.serverName} · {status}
          {latest
            ? ` · Last event ${eventTime(latest.receivedAt, { seconds: false })}`
            : null}
          {binding.subscription &&
          hasInsecureLocalReceiver(binding.subscription) ? (
            <span className="ml-2 text-warning">Plain HTTP</span>
          ) : null}
        </p>
        {problem ? (
          <p role="status" className="text-xs text-muted-foreground">
            {problem}
          </p>
        ) : null}
        <CollapsibleContent className="space-y-2 border-t border-border pt-2">
          {events.length ? (
            <ol aria-label="Recent events" className="space-y-0.5 text-xs">
              {events.map((event) => (
                <li
                  key={event.key}
                  className="flex gap-3"
                  title={event.outcome?.message}
                >
                  <time
                    dateTime={new Date(event.receivedAt).toISOString()}
                    className="tabular-nums text-muted-foreground"
                  >
                    {eventTime(event.receivedAt)}
                  </time>
                  <span>{outcomeLabel(event)}</span>
                </li>
              ))}
            </ol>
          ) : (
            <p className="text-xs text-muted-foreground">
              No events received yet.
            </p>
          )}
          <div className="flex flex-wrap gap-1">
            <Button
              size="sm"
              variant="outline"
              disabled={!connected || !binding.enabled}
              onClick={onTrigger}
            >
              Trigger event
            </Button>
            <Button size="sm" variant="ghost" onClick={onEdit}>
              Edit instructions
            </Button>
            <Button size="sm" variant="ghost" onClick={onTogglePause}>
              {binding.enabled ? "Pause" : "Resume"}
            </Button>
          </div>
        </CollapsibleContent>
        {!hosted && binding.subscription?.mode === "webhook" ? (
          <ReachabilityHeader subscription={binding.subscription} />
        ) : binding.subscription?.lastError ? (
          <p role="alert" className="text-xs text-destructive">
            {binding.subscription.lastError.message}
          </p>
        ) : null}
      </section>
    </Collapsible>
  );
}
