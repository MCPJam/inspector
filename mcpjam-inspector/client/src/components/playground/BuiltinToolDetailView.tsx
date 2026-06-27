/**
 * Detail view for a selected harness built-in tool — the same shape as a server
 * tool's detail (header + Description / Input Schema / Parameters accordions),
 * so built-ins feel identical in the Tools panel. "Run" lives in the panel's
 * top toolbar and asks the agent (see `useBuiltinToolRun`); this view is just
 * the header + schema + parameter form.
 */
import { useEffect, useState } from "react";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@mcpjam/design-system/accordion";
import { ScrollArea } from "@mcpjam/design-system/scroll-area";
import { SchemaViewer } from "@/components/ui/schema-viewer";
import { SelectedToolHeader } from "@/components/ui-playground/SelectedToolHeader";
import { ParametersForm } from "@/components/ui-playground/ParametersForm";
import type { FormField } from "@/lib/tool-form";
import type { HarnessBuiltinToolInfo } from "@/hooks/useHarnessBuiltinTools";

interface BuiltinToolDetailViewProps {
  tool: HarnessBuiltinToolInfo;
  fields: FormField[];
  onExpand: () => void;
  onFieldChange: (name: string, value: unknown) => void;
  onToggleField: (name: string, isSet: boolean) => void;
  /** Optional tool-switcher (other built-in tool names). */
  switchNames?: string[];
  onSwitch?: (name: string) => void;
}

export function BuiltinToolDetailView({
  tool,
  fields,
  onExpand,
  onFieldChange,
  onToggleField,
  switchNames,
  onSwitch,
}: BuiltinToolDetailViewProps) {
  const hasParameters = fields.length > 0;
  const [openSections, setOpenSections] = useState<string[]>(
    hasParameters ? ["parameters"] : ["description"],
  );
  useEffect(() => {
    setOpenSections(hasParameters ? ["parameters"] : ["description"]);
  }, [tool.key, hasParameters]);

  return (
    <div className="h-full flex flex-col">
      <SelectedToolHeader
        toolName={tool.name}
        onExpand={onExpand}
        {...(switchNames && onSwitch
          ? { toolSwitchList: { names: switchNames, onSelect: onSwitch } }
          : {})}
      />
      <p className="px-3 pt-2 text-[10px] leading-snug text-muted-foreground">
        <span className="font-medium text-foreground">Run</span> asks the agent
        to call this tool — it runs in the sandbox (see the Trace tab). Not a
        direct execution.
      </p>
      <ScrollArea className="flex-1 min-h-0">
        <Accordion
          type="multiple"
          value={openSections}
          onValueChange={setOpenSections}
          className="px-3"
        >
          {tool.description && (
            <AccordionItem value="description">
              <AccordionTrigger className="text-xs">
                Description
              </AccordionTrigger>
              <AccordionContent>
                <p className="text-xs text-muted-foreground leading-relaxed">
                  {tool.description}
                </p>
              </AccordionContent>
            </AccordionItem>
          )}
          {tool.inputSchema && (
            <AccordionItem value="input-schema">
              <AccordionTrigger className="text-xs">
                Input Schema
              </AccordionTrigger>
              <AccordionContent>
                <SchemaViewer schema={tool.inputSchema} />
              </AccordionContent>
            </AccordionItem>
          )}
          {hasParameters && (
            <AccordionItem value="parameters">
              <AccordionTrigger className="text-xs">
                Parameters
              </AccordionTrigger>
              <AccordionContent>
                <ParametersForm
                  fields={fields}
                  onFieldChange={onFieldChange}
                  onToggleField={onToggleField}
                />
              </AccordionContent>
            </AccordionItem>
          )}
        </Accordion>
      </ScrollArea>
    </div>
  );
}
