import type { ReactNode } from "react";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@mcpjam/design-system/accordion";
import { SchemaViewer } from "@/components/ui/schema-viewer";
import { ScrollableJsonView } from "@/components/ui/json-editor";

/**
 * A `_meta` or `annotations` bag earns a section only when it has keys.
 * Servers routinely ship `{}`, and an empty accordion row reads as "this tool
 * declares nothing" when the truth is "this tool declared an empty object".
 * An array is malformed here, so it is treated the same as absent.
 */
function hasEntries(value: object | undefined): value is object {
  if (!value || Array.isArray(value)) return false;
  return Object.keys(value).length > 0;
}

/**
 * Description / schema / parameters accordion used by Tools, Playground, and
 * WebMCP invoke. Callers own the parameter form (and any extra description).
 *
 * `annotations` and `metadata` are the tool's own declarations: the safety
 * hints a server claims (`readOnlyHint` and friends) and the `_meta` bag it
 * ships (`openai/profile`, Apps SDK keys, SEP-1865 visibility). They sit above
 * the parameter form so a claim is readable next to the button that runs the
 * tool, and they stay collapsed by default because every caller resets
 * `openSections` to a single section whenever the selected tool changes.
 *
 * Events reuses it for an event type: the second schema is the payload
 * schema (`outputSchemaLabel`), and `children` adds sections after
 * Parameters.
 */
export function ToolDetailsAccordion({
  description,
  descriptionExtra,
  inputSchema,
  outputSchema,
  annotations,
  metadata,
  parameters,
  outputSchemaLabel = "Output Schema",
  openSections,
  onOpenSectionsChange,
  children,
}: {
  description?: string;
  descriptionExtra?: ReactNode;
  inputSchema?: object;
  outputSchema?: object;
  /** `tool.annotations`, MCP or WebMCP shape, rendered verbatim. */
  annotations?: object;
  /** `tool._meta`, already merged with the server's tools metadata upstream. */
  metadata?: object;
  parameters?: ReactNode;
  /** The second schema's heading. */
  outputSchemaLabel?: string;
  openSections: string[];
  onOpenSectionsChange: (value: string[]) => void;
  /** More `AccordionItem`s, after Parameters. */
  children?: ReactNode;
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
          <AccordionTrigger className="text-xs">
            {outputSchemaLabel}
          </AccordionTrigger>
          <AccordionContent>
            <SchemaViewer schema={outputSchema} />
          </AccordionContent>
        </AccordionItem>
      ) : null}
      {hasEntries(annotations) ? (
        <AccordionItem value="annotations">
          <AccordionTrigger className="text-xs">Annotations</AccordionTrigger>
          <AccordionContent>
            <ScrollableJsonView
              value={annotations}
              showLineNumbers={false}
              containerClassName="max-h-96 rounded-md bg-muted/30"
            />
          </AccordionContent>
        </AccordionItem>
      ) : null}
      {hasEntries(metadata) ? (
        <AccordionItem value="metadata">
          <AccordionTrigger className="text-xs">Metadata</AccordionTrigger>
          <AccordionContent>
            <ScrollableJsonView
              value={metadata}
              showLineNumbers={false}
              containerClassName="max-h-96 rounded-md bg-muted/30"
            />
          </AccordionContent>
        </AccordionItem>
      ) : null}
      {parameters ? (
        <AccordionItem value="parameters">
          <AccordionTrigger className="text-xs">Parameters</AccordionTrigger>
          <AccordionContent>{parameters}</AccordionContent>
        </AccordionItem>
      ) : null}
      {children}
    </Accordion>
  );
}
