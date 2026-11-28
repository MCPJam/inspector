import { useEffect, useRef, useState } from "react";
import {
  describeNoSubscribableMode,
  subscribableModes,
} from "@mcpjam/sdk/browser";
import { Button } from "@mcpjam/design-system/button";
import { Input } from "@mcpjam/design-system/input";
import { Label } from "@mcpjam/design-system/label";
import { Textarea } from "@mcpjam/design-system/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@mcpjam/design-system/dialog";
import {
  SubscribeAdvanced,
  SubscribeDelivery,
  SubscribeParameters,
} from "@/components/events/SubscribeForm";
import { useSubscribeForm } from "@/components/events/use-subscribe-form";
import { EventDataView } from "@/components/events/EventsFeedPanel";
import type { EventDescriptorView } from "@/shared/events-api";
import { serverHasSignIn } from "@/components/connection/server-auth";
import {
  usePlaygroundEvents,
  type ServerEventCatalog,
} from "./PlaygroundEventsProvider";

type Runtime = NonNullable<ReturnType<typeof usePlaygroundEvents>>;
export function AddPlaygroundEvent({
  runtime,
  onClose,
}: {
  runtime: Runtime;
  onClose: () => void;
}) {
  const [search, setSearch] = useState("");
  const connectedServers = Object.entries(runtime.servers)
    .filter(([, server]) => server.connectionStatus === "connected")
    .map(([name]) => name)
    .sort()
    .join("\n");
  const refresh = useRef(runtime.refresh);
  refresh.current = runtime.refresh;
  useEffect(() => {
    void refresh.current();
  }, [connectedServers]);

  const [selected, setSelected] = useState<{
    server: ServerEventCatalog;
    event: EventDescriptorView;
  } | null>(null);
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>
            {selected ? selected.event.name : "Connect event"}
          </DialogTitle>
          <DialogDescription>
            {selected
              ? `${selected.server.serverName}. ${selected.event.description ?? ""}`
              : "Choose an event type from your connected servers."}
          </DialogDescription>
        </DialogHeader>
        {selected ? (
          <ConfigureEvent
            key={`${selected.server.serverName}:${selected.event.name}`}
            runtime={runtime}
            {...selected}
            onBack={() => setSelected(null)}
            onClose={onClose}
          />
        ) : (
          <>
            <Input
              aria-label="Search event types"
              placeholder="Search event types or servers…"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
            {runtime.loading ? (
              <p className="text-sm text-muted-foreground">Loading events…</p>
            ) : runtime.catalogs.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                Connect a server to browse its events.
              </p>
            ) : (
              runtime.catalogs.map((server) => (
                <section key={server.serverName} className="space-y-1">
                  <h3 className="text-xs font-medium text-muted-foreground">
                    {server.serverName}
                  </h3>
                  {server.error ? (
                    <p role="alert" className="text-xs text-destructive">
                      {server.error}
                    </p>
                  ) : !server.catalog?.events.length ? (
                    <p className="text-xs text-muted-foreground">
                      No events available
                    </p>
                  ) : (
                    server.catalog.events
                      .filter((event) =>
                        `${event.name} ${server.serverName} ${event.description}`
                          .toLowerCase()
                          .includes(search.toLowerCase()),
                      )
                      .map((event) => (
                        <button
                          type="button"
                          key={event.name}
                          onClick={() => setSelected({ server, event })}
                          className="block w-full rounded-md px-3 py-2 text-left hover:bg-accent"
                        >
                          <span className="font-mono text-sm">
                            {event.name}
                          </span>
                          <span className="block text-xs text-muted-foreground">
                            {event.description}
                          </span>
                        </button>
                      ))
                  )}
                </section>
              ))
            )}
            <Button
              variant="outline"
              onClick={() => void runtime.refresh()}
              disabled={runtime.loading}
            >
              Refresh events
            </Button>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

function ConfigureEvent({
  runtime,
  server,
  event,
  onBack,
  onClose,
}: {
  runtime: Runtime;
  server: ServerEventCatalog;
  event: EventDescriptorView;
  onBack: () => void;
  onClose: () => void;
}) {
  const [instructions, setInstructions] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const availability = runtime.host
    ? subscribableModes({
        host: null,
        hostModes: runtime.host.modes,
        eventModes: event.delivery,
        runtime: runtime.hosted ? "hosted" : "local",
      })
    : undefined;
  const blocked = !runtime.host
    ? "Loading client settings…"
    : runtime.host.missing
      ? "Select an available client to connect an event."
      : availability
        ? describeNoSubscribableMode(
            availability,
            runtime.host.name,
            runtime.host.harnessName,
          )
        : null;
  const testOnly =
    !!runtime.host && !runtime.host.missing && availability?.modes.length === 0;
  const form = useSubscribeForm({
    event,
    modes: availability?.modes ?? [],
    blockedReason: blocked,
    hosted: runtime.hosted,
    serverSignedIn: serverHasSignIn(runtime.servers[server.serverName]),
    projectId: runtime.projectId,
    serverId: server.serverName,
    busy,
    onSubscribe: async (value) => {
      if (!instructions.trim()) {
        setError("Enter what the agent should do when this event arrives.");
        return;
      }
      setBusy(true);
      setError(null);
      try {
        await runtime.add(server, event, value, instructions.trim());
        onClose();
      } catch (cause) {
        setError(
          cause instanceof Error
            ? cause.message
            : "Couldn't connect the event. Try again.",
        );
      } finally {
        setBusy(false);
      }
    },
  });
  return (
    <div className="space-y-4">
      <Button variant="ghost" size="sm" onClick={onBack} disabled={busy}>
        Back to event types
      </Button>
      {!testOnly ? <SubscribeParameters form={form} /> : null}
      <div className="space-y-2">
        <Label htmlFor="event-instructions">Instructions</Label>
        <Textarea
          id="event-instructions"
          placeholder="What should the agent do when this event arrives?"
          value={instructions}
          onChange={(event) => setInstructions(event.target.value)}
          rows={3}
        />
      </div>
      <details
        open={form.mode === "webhook" || !!blocked}
        className="text-xs"
      >
        <summary className="cursor-pointer py-2 text-muted-foreground">
          Delivery · {form.mode ?? (runtime.host ? "Unavailable" : "Loading…")}
        </summary>
        <SubscribeDelivery
          form={form}
          eventName={event.name}
          delivery={event.delivery}
          availability={availability}
          hostName={runtime.host?.name ?? "Current client"}
          hosted={runtime.hosted}
          replayUnsupported={false}
          localCallbackBase={server.catalog?.localCallbackBase}
        />
        {blocked ? (
          <p role="alert" className="py-2 text-destructive">
            {blocked}
          </p>
        ) : null}
      </details>
      {!runtime.hosted && form.mode === "webhook" ? (
        <details className="text-xs">
          <summary className="cursor-pointer py-2 text-muted-foreground">Advanced settings</summary>
          <SubscribeAdvanced form={form} eventName={event.name} hosted={false} />
        </details>
      ) : null}
      <details className="text-xs">
        <summary className="cursor-pointer py-2 text-muted-foreground">
          Schemas and metadata
        </summary>
        <EventDataView data={event} />
      </details>
      <p className="text-xs text-muted-foreground">
        {testOnly
          ? "Test data runs as a Playground message. This client does not receive live MCP events."
          : "The agent runs in this conversation while Playground is open. The server subscription stays available in Events."}
      </p>
      {error || form.formError ? (
        <p role="alert" className="text-xs text-destructive">
          {error ?? form.formError}
        </p>
      ) : null}
      {runtime.agentBlockedReason ? (
        <p role="status" className="text-xs text-muted-foreground">
          {runtime.agentBlockedReason}
        </p>
      ) : null}
      <Button
        onClick={
          testOnly
            ? () => {
                try {
                  runtime.addTest(server, event, instructions.trim());
                  onClose();
                } catch (cause) {
                  setError(
                    cause instanceof Error
                      ? cause.message
                      : "Couldn't connect the test event. Try again.",
                  );
                }
              }
            : form.submit
        }
        disabled={
          (!testOnly && !form.canSubmit) ||
          !instructions.trim() ||
          !!runtime.agentBlockedReason
        }
      >
        {busy
          ? "Connecting event…"
          : testOnly
            ? "Connect test event"
            : "Connect event"}
      </Button>
    </div>
  );
}
