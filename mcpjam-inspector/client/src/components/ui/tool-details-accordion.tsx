import type { ReactNode } from "react";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@mcpjam/design-system/accordion";
import { SchemaViewer } from "@/components/ui/schema-viewer";

/**
 * Description / schema / parameters accordion used by Tools, Playground, and
 * WebMCP invoke. Callers own the parameter form (and any extra description).
 */
export function ToolDetailsAccordion({
  description,
  descriptionExtra,
  inputSchema,
  outputSchema,
  parameters,
  openSections,
  onOpenSectionsChange,
}: {
  description?: string;
  descriptionExtra?: ReactNode;
  inputSchema?: object;
  outputSchema?: object;
  parameters?: ReactNode;
  openSections: string[];
  onOpenSectionsChange: (value: string[]) => void;
}) {
  return (
    <Accordion
      type="multiple"
      value={openSections}
      onValueChange={onOpenSectionsChange}
      className="px-3"
    >
      {description ? (
        <AccordionItem value="description">
          <AccordionTrigger className="text-xs">Description</AccordionTrigger>
          <AccordionContent>
            <p className="text-xs leading-relaxed text-muted-foreground">
              {description}
            </p>
            {descriptionExtra}
          </AccordionContent>
        </AccordionItem>
      ) : null}
      {inputSchema ? (
        <AccordionItem value="input-schema">
          <AccordionTrigger className="text-xs">Input Schema</AccordionTrigger>
          <AccordionContent>
            <SchemaViewer schema={inputSchema} />
          </AccordionContent>
        </AccordionItem>
      ) : null}
      {outputSchema ? (
        <AccordionItem value="output-schema">
          <AccordionTrigger className="text-xs">Output Schema</AccordionTrigger>
          <AccordionContent>
            <SchemaViewer schema={outputSchema} />
          </AccordionContent>
        </AccordionItem>
      ) : null}
      {parameters ? (
        <AccordionItem value="parameters">
          <AccordionTrigger className="text-xs">Parameters</AccordionTrigger>
          <AccordionContent>{parameters}</AccordionContent>
        </AccordionItem>
      ) : null}
    </Accordion>
  );
}
