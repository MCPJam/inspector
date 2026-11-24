import { useEffect, useState } from "react";
import { ScrollArea } from "@mcpjam/design-system/scroll-area";
import { Button } from "@mcpjam/design-system/button";
import {
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@mcpjam/design-system/accordion";
import type { SubscribableModes } from "@mcpjam/sdk/browser";
import { SelectedToolHeader } from "@/components/ui-playground/SelectedToolHeader";
import { ToolDetailsAccordion } from "@/components/ui/tool-details-accordion";
import { ScrollableJsonView } from "@/components/ui/json-editor";
import type { EventDescriptorView } from "@/shared/events-api";
import type { SubscribeForm } from "./use-subscribe-form";
import {
  SubscribeAdvanced,
  SubscribeDelivery,
  SubscribeParameters,
} from "./SubscribeForm";

const DEFAULT_OPEN = ["parameters", "delivery"];

export interface BlockedAction {
  label: string;
  onClick: () => void;
}

/**
 * One event type, replacing the list in the left pane the way a selected
 * tool does: its descriptor in the Tools accordion, then the subscription
 * it would create. The header's Subscribe button submits `form`.
 */
export function EventTypeDetail({
  event,
  events,
  onBack,
  onSwitch,
  form,
  availability,
  hostName,
  hosted,
  blockedReason,
  blockedAction,
  replayUnsupported,
}: {
  event: EventDescriptorView;
  /** The loaded event types, for the switch menu. */
  events: EventDescriptorView[];
  onBack: () => void;
  onSwitch: (eventName: string) => void;
  form: SubscribeForm;
  availability: SubscribableModes | undefined;
  hostName: string;
  hosted: boolean;
  blockedReason: string | null;
  blockedAction?: BlockedAction;
  replayUnsupported: boolean;
}) {
  const [openSections, setOpenSections] = useState<string[]>(DEFAULT_OPEN);
  useEffect(() => setOpenSections(DEFAULT_OPEN), [event.name]);

  return (
    <div
      className="flex min-h-0 flex-1 flex-col"
      data-testid="event-type-detail"
    >
      <SelectedToolHeader
        toolName={event.name}
        listLabel="event type"
        onExpand={onBack}
        toolSwitchList={{
          items: events.map((item) => ({ id: item.name, label: item.name })),
          selectedId: event.name,
          onSelect: onSwitch,
        }}
      />
      <div className="flex-1 overflow-hidden">
        <ScrollArea className="h-full">
          <div className="pb-16">
            {blockedReason ? (
              <div
                className="mx-3 mt-3 space-y-2 rounded-md border border-border bg-muted/40 p-3 text-xs text-foreground"
                data-testid="subscribe-blocked"
              >
                <p>{blockedReason}</p>
                {blockedAction ? (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="h-7 text-xs"
                    onClick={blockedAction.onClick}
                  >
                    {blockedAction.label}
                  </Button>
                ) : null}
              </div>
            ) : null}
            <ToolDetailsAccordion
              description={event.description}
              inputSchema={event.inputSchema}
              outputSchema={event.payloadSchema}
              outputSchemaLabel="Payload Schema"
              metadata={event._meta}
              openSections={openSections}
              onOpenSectionsChange={setOpenSections}
              parameters={<SubscribeParameters form={form} />}
            >
              <AccordionItem value="delivery">
                <AccordionTrigger className="text-xs">
                  Delivery
                </AccordionTrigger>
                <AccordionContent>
                  <SubscribeDelivery
                    form={form}
                    eventName={event.name}
                    delivery={event.delivery}
                    availability={availability}
                    hostName={hostName}
                    hosted={hosted}
                    replayUnsupported={replayUnsupported}
                  />
                </AccordionContent>
              </AccordionItem>
              <AccordionItem value="advanced">
                <AccordionTrigger className="text-xs">
                  Advanced settings
                </AccordionTrigger>
                <AccordionContent>
                  <SubscribeAdvanced form={form} eventName={event.name} />
                </AccordionContent>
              </AccordionItem>
              <AccordionItem value="definition">
                <AccordionTrigger className="text-xs">
                  Full event definition
                </AccordionTrigger>
                <AccordionContent>
                  <ScrollableJsonView
                    value={event}
                    showLineNumbers={false}
                    containerClassName="max-h-96 rounded-md bg-muted/30"
                  />
                </AccordionContent>
              </AccordionItem>
            </ToolDetailsAccordion>
            {form.formError ? (
              <p role="alert" className="px-3 pt-2 text-xs text-destructive">
                {form.formError}
              </p>
            ) : null}
          </div>
        </ScrollArea>
      </div>
    </div>
  );
}
