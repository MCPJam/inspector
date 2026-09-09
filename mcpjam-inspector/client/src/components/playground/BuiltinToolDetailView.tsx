/**
 * Detail view for a selected harness built-in tool — the same shape as a server
 * tool's detail (header + Description / Input Schema / Parameters accordions),
 * so built-ins feel identical in the Tools panel. "Run" lives in the panel's
 * top toolbar and asks the agent (see `useBuiltinToolRun`); this view is just
 * the header + schema + parameter form.
 */
import { useEffect, useState } from "react";
import { ScrollArea } from "@mcpjam/design-system/scroll-area";
import { SelectedToolHeader } from "@/components/ui-playground/SelectedToolHeader";
import { ParametersForm } from "@/components/ui-playground/ParametersForm";
import { ToolDetailsAccordion } from "@/components/ui/tool-details-accordion";
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
          ? {
              toolSwitchList: {
                items: switchNames.map((name) => ({ id: name, label: name })),
                selectedId: tool.name,
                onSelect: onSwitch,
              },
            }
          : {})}
      />
      <p className="px-3 pt-2 text-[10px] leading-snug text-muted-foreground">
        <span className="font-medium text-foreground">Run</span> asks the agent
        to call this tool — it runs in the sandbox (see the Trace tab). Not a
        direct execution.
      </p>
      <ScrollArea className="flex-1 min-h-0">
        <ToolDetailsAccordion
          description={tool.description}
          inputSchema={tool.inputSchema}
          openSections={openSections}
          onOpenSectionsChange={setOpenSections}
          parameters={
            hasParameters ? (
              <ParametersForm
                fields={fields}
                onFieldChange={onFieldChange}
                onToggleField={onToggleField}
              />
            ) : undefined
          }
        />
      </ScrollArea>
    </div>
  );
}
