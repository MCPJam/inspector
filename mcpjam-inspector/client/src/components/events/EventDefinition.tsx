import { Badge } from "@mcpjam/design-system/badge";
import { useState } from "react";
import {
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@mcpjam/design-system/accordion";
import { ScrollableJsonView } from "@/components/ui/json-editor";
import { ToolDetailsAccordion } from "@/components/ui/tool-details-accordion";
import type { EventDescriptorView } from "@/shared/events-api";

export function EventDefinition({ event }: { event: EventDescriptorView }) {
  const [openSections, setOpenSections] = useState(["description"]);

  return (
    <ToolDetailsAccordion
      description={event.description}
      inputSchema={event.inputSchema}
      outputSchema={event.payloadSchema}
      outputSchemaLabel="Payload schema"
      metadata={event._meta}
      openSections={openSections}
      onOpenSectionsChange={setOpenSections}
    >
      <AccordionItem value="delivery">
        <AccordionTrigger className="text-xs">
          Supported delivery
        </AccordionTrigger>
        <AccordionContent className="flex flex-wrap gap-1">
          {event.delivery.map((mode) => (
            <Badge key={mode} variant="outline">
              {mode}
            </Badge>
          ))}
        </AccordionContent>
      </AccordionItem>
      <AccordionItem value="definition">
        <AccordionTrigger className="text-xs">
          Raw JSON
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
  );
}
