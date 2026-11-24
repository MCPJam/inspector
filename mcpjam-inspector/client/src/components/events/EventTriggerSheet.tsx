import { useState } from "react";
import { Zap } from "lucide-react";
import { Button } from "@mcpjam/design-system/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@mcpjam/design-system/sheet";
import type {
  EventDescriptorView,
  EventsSimulateRequest,
  EventsSubscriptionView,
} from "@/shared/events-api";
import { SimulatePanel } from "./SimulatePanel";

export function EventTriggerSheet({
  subscriptions,
  events,
  busy,
  onSimulate,
}: {
  subscriptions: EventsSubscriptionView[];
  events: EventDescriptorView[];
  busy: boolean;
  onSimulate: (request: EventsSimulateRequest) => Promise<boolean>;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          disabled={subscriptions.length === 0}
          title={
            subscriptions.length === 0
              ? "Subscribe to an event first"
              : undefined
          }
        >
          <Zap className="size-4" />
          Trigger event
        </Button>
      </SheetTrigger>
      <SheetContent className="w-full overflow-y-auto sm:max-w-lg">
        <SheetHeader>
          <SheetTitle>Trigger event</SheetTitle>
          <SheetDescription data-testid="simulate-warning">
            Deliver a test event to this subscription in MCPJam. Matching
            triggers can run. The event is not sent to the server.
          </SheetDescription>
        </SheetHeader>
        <div className="px-4 pb-4">
          <SimulatePanel
            subscriptions={subscriptions}
            events={events}
            busy={busy}
            onSimulate={async (request) => {
              if (await onSimulate(request)) setOpen(false);
            }}
          />
        </div>
      </SheetContent>
    </Sheet>
  );
}
