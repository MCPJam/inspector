import { BookOpen, Radio, Server } from "lucide-react";
import { Button } from "@mcpjam/design-system/button";
import type { EventsListResponse } from "@/shared/events-api";
import { CapabilityPanel } from "./CapabilityPanel";

interface EventsEmptyHeroProps {
  serverName?: string;
  catalog?: EventsListResponse;
  onOpenServers: () => void;
}

export function EventsEmptyHero({
  serverName,
  catalog,
  onOpenServers,
}: EventsEmptyHeroProps) {
  return (
    <div className="flex min-h-0 flex-1 overflow-auto px-6 py-10">
      <section
        aria-labelledby="events-empty-title"
        className="m-auto flex w-full max-w-lg flex-col items-center text-center"
      >
        <div className="relative grid size-32 place-items-center" aria-hidden>
          <span className="absolute size-[120px] rounded-full border" />
          <span className="absolute size-24 rounded-full border" />
          <span className="absolute size-[74px] rounded-full border" />
          <span className="absolute top-5 left-5 size-2 rounded-full bg-primary" />
          <span className="grid size-12 place-items-center rounded-full bg-accent text-accent-foreground">
            <Radio className="size-6" />
          </span>
        </div>
        <h2
          id="events-empty-title"
          className="mt-3 text-balance text-2xl font-semibold tracking-tight text-foreground sm:text-3xl"
        >
          Inspect your server’s events
        </h2>
        <p className="mt-2 max-w-md text-pretty text-sm text-muted-foreground">
          Subscribe to an event type and inspect each delivery as it arrives.
        </p>
        <p className="mt-4 max-w-full text-sm wrap-anywhere">
          {catalog && serverName ? (
            <>
              <span className="font-medium">{serverName}</span> doesn’t advertise
              Events.
            </>
          ) : (
            "Choose an MCP server to get started."
          )}
        </p>
        <div className="mt-4 flex flex-wrap items-center justify-center gap-2">
          <Button type="button" onClick={onOpenServers}>
            <Server className="size-4" />
            Open Servers
          </Button>
          <Button variant="ghost" asChild>
            <a
              href="https://docs.mcpjam.com/inspector/events"
              target="_blank"
              rel="noreferrer"
            >
              <BookOpen className="size-4" />
              Read Events docs
            </a>
          </Button>
        </div>
        {catalog && (
          <details className="mt-5 w-full max-w-md border-t text-left">
            <summary className="cursor-pointer py-2 text-xs">
              Capability details
            </summary>
            <div className="pb-2">
              <CapabilityPanel catalog={catalog} />
            </div>
          </details>
        )}
      </section>
    </div>
  );
}
