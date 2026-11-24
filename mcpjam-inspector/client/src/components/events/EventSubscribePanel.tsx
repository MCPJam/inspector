import { Button } from "@mcpjam/design-system/button";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@mcpjam/design-system/accordion";
import type { SubscribableModes } from "@mcpjam/sdk/browser";
import type { EventDescriptorView } from "@/shared/events-api";
import {
  SubscribeAdvanced,
  SubscribeDelivery,
  SubscribeParameters,
} from "./SubscribeForm";
import type { SubscribeForm } from "./use-subscribe-form";

export function EventSubscribePanel({
  event,
  form,
  availability,
  hostName,
  hosted,
  blockedReason,
  blockedAction,
  replayUnsupported,
  localCallbackBase,
}: {
  event: EventDescriptorView;
  form: SubscribeForm;
  availability?: SubscribableModes;
  hostName: string;
  hosted: boolean;
  blockedReason: string | null;
  blockedAction?: { label: string; onClick: () => void };
  replayUnsupported: boolean;
  localCallbackBase?: string;
}) {
  return (
    <div data-testid="event-subscribe-panel">
      {blockedReason ? (
        <div
          className="mb-4 space-y-2 rounded-md border border-border bg-muted/40 p-3 text-xs"
          data-testid="subscribe-blocked"
        >
          <p>{blockedReason}</p>
          {blockedAction ? (
            <Button variant="outline" size="sm" onClick={blockedAction.onClick}>
              {blockedAction.label}
            </Button>
          ) : null}
        </div>
      ) : null}
      <Accordion type="multiple" defaultValue={["parameters", "delivery"]}>
        <AccordionItem value="parameters">
          <AccordionTrigger>Parameters</AccordionTrigger>
          <AccordionContent>
            <SubscribeParameters form={form} />
          </AccordionContent>
        </AccordionItem>
        <AccordionItem value="delivery">
          <AccordionTrigger>Delivery</AccordionTrigger>
          <AccordionContent>
            <SubscribeDelivery
              form={form}
              eventName={event.name}
              delivery={event.delivery}
              availability={availability}
              hostName={hostName}
              hosted={hosted}
              replayUnsupported={replayUnsupported}
              localCallbackBase={localCallbackBase}
            />
          </AccordionContent>
        </AccordionItem>
        <AccordionItem value="advanced">
          <AccordionTrigger>Advanced settings</AccordionTrigger>
          <AccordionContent>
            <SubscribeAdvanced form={form} eventName={event.name} hosted={hosted} />
          </AccordionContent>
        </AccordionItem>
      </Accordion>
      {form.formError ? (
        <p role="alert" className="pt-2 text-xs text-destructive">
          {form.formError}
        </p>
      ) : null}
    </div>
  );
}
