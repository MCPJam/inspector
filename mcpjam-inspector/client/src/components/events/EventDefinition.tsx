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
      <AccordionItem value="definition">
        <AccordionTrigger className="text-xs">Full event definition</AccordionTrigger>
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
