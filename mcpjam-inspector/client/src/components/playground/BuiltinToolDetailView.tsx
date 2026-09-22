/**
 * Detail view for a selected harness built-in tool — the same shape as a server
 * tool's detail (header + Description / Input Schema / Parameters accordions),
 * so built-ins feel identical in the Tools panel. "Run" lives in the panel's
 * top toolbar (ask-the-agent for harness / `browser_*`; direct invoke for
 * page tools). This view is the header + schema + parameter form.
 */
import { useEffect, useState } from "react";
import { ScrollArea } from "@mcpjam/design-system/scroll-area";
import { SelectedToolHeader } from "@/components/ui-playground/SelectedToolHeader";
import { ParametersForm } from "@/components/ui-playground/ParametersForm";
import { ToolDetailsAccordion } from "@/components/ui/tool-details-accordion";
import { cn } from "@/lib/utils";
import type { FormField } from "@/lib/tool-form";
import type { HarnessBuiltinToolInfo } from "@/hooks/useHarnessBuiltinTools";

interface BuiltinToolDetailViewProps {
  tool: Pick<HarnessBuiltinToolInfo, "key" | "name" | "description" | "inputSchema">;
  fields: FormField[];
  onExpand: () => void;
  onFieldChange: (name: string, value: unknown) => void;
  onToggleField: (name: string, isSet: boolean) => void;
  /** Optional tool-switcher (other built-in tool names). */
  switchNames?: string[];
  /** Switcher items when the id is not the display name (browser / page tools). */
  switchItems?: { id: string; label: string }[];
  selectedSwitchId?: string;
  onSwitch?: (name: string) => void;
  /**
   * What Run does. Built-ins default to the sandbox wording; browser / page
   * tools pass their own so we never call a signed-in Chromium a sandbox.
   */
  runHint?: string;
  headerDescription?: string;
  /** Last invoke result, when Run called the page directly. */
  result?: { ok: boolean; text: string } | null;
}

export function BuiltinToolDetailView({
  tool,
  fields,
  onExpand,
  onFieldChange,
  onToggleField,
  switchNames,
  switchItems,
  selectedSwitchId,
  onSwitch,
  runHint = "asks the agent to call this tool — it runs in the sandbox (see the Trace tab). Not a direct execution.",
  headerDescription,
  result,
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
        description={headerDescription}
        onExpand={onExpand}
        {...((switchItems ?? switchNames) && onSwitch
          ? {
              toolSwitchList: {
                items:
                  switchItems ??
                  (switchNames ?? []).map((name) => ({
                    id: name,
                    label: name,
                  })),
                selectedId: selectedSwitchId ?? tool.name,
                onSelect: onSwitch,
              },
            }
          : {})}
      />
      <p className="px-3 pt-2 text-[10px] leading-snug text-muted-foreground">
        <span className="font-medium text-foreground">Run</span> {runHint}
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
        {result ? (
          <div className="px-3 pb-3">
            <p className="text-xs font-medium text-foreground">Result</p>
            <pre
              className={cn(
                "mt-1 overflow-x-auto rounded-md border border-border bg-muted/50 p-2 font-mono text-[11px]",
                result.ok ? "text-foreground" : "text-destructive",
              )}
            >
              {result.text}
            </pre>
          </div>
        ) : null}
      </ScrollArea>
    </div>
  );
}
