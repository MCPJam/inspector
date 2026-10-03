import { useEffect, useMemo, useState } from "react";
import { Button } from "@mcpjam/design-system/button";
import { Input } from "@mcpjam/design-system/input";
import { Label } from "@mcpjam/design-system/label";
import { Textarea } from "@mcpjam/design-system/textarea";
import { FlaskConical, Loader2 } from "lucide-react";
import type {
  EventDescriptorView,
  EventsSimulateRequest,
  EventsSubscriptionView,
} from "@/shared/events-api";
import { safeJson, simulationDataFromSchema } from "./event-utils";

/**
 * Send a simulated event to one subscription. It is journalled in the
 * `simulation` namespace (contract C2), so it can never collide with, or
 * suppress, a live run.
 */
export function SimulatePanel({
  subscriptions,
  events,
  busy,
  onSimulate,
}: {
  subscriptions: EventsSubscriptionView[];
  events: EventDescriptorView[];
  busy: boolean;
  onSimulate: (request: EventsSimulateRequest) => void | Promise<void>;
}) {
  const [subscriptionId, setSubscriptionId] = useState<string>("");
  const [eventId, setEventId] = useState("");
  const [dataJson, setDataJson] = useState("{}");
  const [error, setError] = useState<string | null>(null);

  const selected = useMemo(
    () =>
      subscriptions.find(
        (subscription) => subscription.id === subscriptionId,
      ) ?? subscriptions[0],
    [subscriptions, subscriptionId],
  );

  // Prefill the payload from the event's payload schema whenever the target
  // subscription (and so the event type) changes.
  const selectedEventName = selected?.eventName;
  useEffect(() => {
    if (!selectedEventName) return;
    const descriptor = events.find((event) => event.name === selectedEventName);
    setDataJson(safeJson(simulationDataFromSchema(descriptor?.payloadSchema)));
    setError(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedEventName, selected?.id]);

  if (subscriptions.length === 0) {
    return (
      <p className="text-xs text-muted-foreground">
        Subscribe to an event first; a simulated event is delivered to one of
        this server's subscriptions.
      </p>
    );
  }

  const send = () => {
    if (!selected) return;
    let data: unknown;
    try {
      data = JSON.parse(dataJson || "{}");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Invalid JSON.");
      return;
    }
    if (typeof data !== "object" || data === null || Array.isArray(data)) {
      setError("Event data must be a JSON object.");
      return;
    }
    setError(null);
    void onSimulate({
      subscriptionId: selected.id,
      event: {
        name: selected.eventName,
        ...(eventId.trim() ? { eventId: eventId.trim() } : {}),
        data: data as Record<string, unknown>,
      },
    });
  };

  return (
    <div className="space-y-3" data-testid="simulate-panel">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div className="space-y-1">
          <Label htmlFor="simulate-subscription" className="text-xs">
            Subscription
          </Label>
          <select
            id="simulate-subscription"
            value={selected?.id ?? ""}
            onChange={(e) => setSubscriptionId(e.target.value)}
            className="h-8 w-full rounded-md border border-border bg-background px-2 text-xs text-foreground"
          >
            {subscriptions.map((subscription) => (
              <option key={subscription.id} value={subscription.id}>
                {subscription.eventName} ({subscription.mode})
              </option>
            ))}
          </select>
        </div>
        <div className="space-y-1">
          <Label htmlFor="simulate-event-id" className="text-xs">
            eventId (optional)
          </Label>
          <Input
            id="simulate-event-id"
            value={eventId}
            onChange={(e) => setEventId(e.target.value)}
            placeholder="Generated when empty"
            className="h-8 text-xs"
          />
        </div>
      </div>
      <div className="space-y-1">
        <Label htmlFor="simulate-data" className="text-xs">
          Event data (JSON)
        </Label>
        <Textarea
          id="simulate-data"
          value={dataJson}
          onChange={(e) => setDataJson(e.target.value)}
          spellCheck={false}
          rows={6}
          className="font-mono text-xs"
        />
      </div>
      {error ? (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      ) : null}
      <Button
        type="button"
        size="sm"
        variant="outline"
        onClick={send}
        disabled={busy || !selected}
      >
        {busy ? (
          <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
        ) : (
          <FlaskConical className="mr-1.5 h-3.5 w-3.5" />
        )}
        Send simulated event
      </Button>
    </div>
  );
}
