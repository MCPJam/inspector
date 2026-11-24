import { BellPlus, Loader2 } from "lucide-react";
import { Button } from "@mcpjam/design-system/button";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@mcpjam/design-system/accordion";
import { ScrollArea } from "@mcpjam/design-system/scroll-area";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@mcpjam/design-system/sheet";
import type { SubscribableModes } from "@mcpjam/sdk/browser";
import type { EventDescriptorView } from "@/shared/events-api";
import {
  SubscribeAdvanced,
  SubscribeDelivery,
  SubscribeParameters,
} from "./SubscribeForm";
import type { SubscribeForm } from "./use-subscribe-form";

export function EventSubscribeSheet({
  event,
  form,
  availability,
  hostName,
  hosted,
  blockedReason,
  blockedAction,
  replayUnsupported,
  subscribing,
  open,
  onOpenChange,
}: {
  event: EventDescriptorView;
  form: SubscribeForm;
  availability?: SubscribableModes;
  hostName: string;
  hosted: boolean;
  blockedReason: string | null;
  blockedAction?: { label: string; onClick: () => void };
  replayUnsupported: boolean;
  subscribing: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetTrigger asChild>
        <Button size="sm">
          <BellPlus className="size-4" />
          Subscribe
        </Button>
      </SheetTrigger>
      <SheetContent className="w-full gap-0 sm:max-w-lg">
        <SheetHeader className="border-b border-border pr-10">
          <SheetTitle>Subscribe to event</SheetTitle>
          <SheetDescription className="break-all font-mono">
            {event.name}
          </SheetDescription>
        </SheetHeader>
        <ScrollArea className="min-h-0 flex-1">
          {blockedReason ? (
            <div
              className="mx-4 mt-4 space-y-2 rounded-md border border-border bg-muted/40 p-3 text-xs"
              data-testid="subscribe-blocked"
            >
              <p>{blockedReason}</p>
              {blockedAction ? (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={blockedAction.onClick}
                >
                  {blockedAction.label}
                </Button>
              ) : null}
            </div>
          ) : null}
          <Accordion
            type="multiple"
            defaultValue={["parameters", "delivery"]}
            className="px-4"
          >
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
                />
              </AccordionContent>
            </AccordionItem>
            <AccordionItem value="advanced">
              <AccordionTrigger>Advanced settings</AccordionTrigger>
              <AccordionContent>
                <SubscribeAdvanced form={form} eventName={event.name} />
              </AccordionContent>
            </AccordionItem>
          </Accordion>
          {form.formError ? (
            <p role="alert" className="px-4 pt-2 text-xs text-destructive">
              {form.formError}
            </p>
          ) : null}
        </ScrollArea>
        <SheetFooter className="border-t border-border sm:items-end">
          <Button disabled={!form.canSubmit} onClick={form.submit}>
            {subscribing ? <Loader2 className="size-4 animate-spin" /> : null}
            {subscribing ? "Subscribing…" : "Subscribe"}
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}
