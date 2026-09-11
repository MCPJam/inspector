import { forwardRef, useEffect, useImperativeHandle, useState } from "react";
import { Button } from "@mcpjam/design-system/button";
import {
  generateFormFieldsFromSchema,
  buildParametersFromFields,
  type FormField,
} from "@/lib/tool-form";
import { ParametersForm } from "@/components/ui-playground/ParametersForm";
import { ToolDetailsAccordion } from "@/components/ui/tool-details-accordion";
import type { WebMcpToolDescriptor } from "@/shared/webmcp-inspector-protocol";

export interface ToolInvokeHandle {
  submit: () => void;
}

export interface ToolInvokePaneProps {
  tool: WebMcpToolDescriptor;
  pendingInvokeId: string | undefined;
  onInvoke: (input: Record<string, unknown>) => void;
  onCancel: (invokeId: string) => void;
}

/**
 * Invoke one page tool.
 *
 * Manual invocation is NOT gated: a person clicking Invoke on a tool they can
 * see, on a page they opened, has already made the decision an approval prompt
 * would ask them to make. (Model-driven calls are a different matter and do
 * gate — see the chat integration.)
 *
 * Input is a generated form by default, falling back to raw JSON. The form is
 * the point: it is what makes a schema legible, and it is the thing a raw
 * textarea cannot do.
 */
export const ToolInvokePane = forwardRef<ToolInvokeHandle, ToolInvokePaneProps>(
  function ToolInvokePane({ tool, pendingInvokeId, onInvoke, onCancel }, ref) {
    const [fields, setFields] = useState<FormField[]>([]);
    const [rawMode, setRawMode] = useState(false);
    const [rawJson, setRawJson] = useState("{}");
    const [rawError, setRawError] = useState<string | undefined>();
    const [openSections, setOpenSections] = useState<string[]>(["parameters"]);

    useEffect(() => {
      const next = generateFormFieldsFromSchema(tool.inputSchema);
      setFields(next);
      setRawJson("{}");
      setRawError(undefined);
      // A schema with no describable properties has nothing to render as a form,
      // so those tools start in raw mode rather than showing an empty one.
      setRawMode(next.length === 0);
      setOpenSections(next.length === 0 ? ["description"] : ["parameters"]);
      // Keyed on the tool's stable identity ALONE. The store replaces `tools`
      // wholesale on every frame, so `tool` and `tool.inputSchema` are new object
      // identities each time the page re-registers — depending on them would wipe
      // whatever the user was typing, and revert a deliberate "Use JSON" choice,
      // every time the page touched its registry.
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [tool.toolKey]);

    const submit = () => {
      if (pendingInvokeId) return;
      if (rawMode) {
        try {
          const parsed = JSON.parse(rawJson || "{}");
          if (
            typeof parsed !== "object" ||
            parsed === null ||
            Array.isArray(parsed)
          ) {
            setRawError("Input must be a JSON object.");
            return;
          }
          setRawError(undefined);
          onInvoke(parsed as Record<string, unknown>);
        } catch (error) {
          setRawError(error instanceof Error ? error.message : "Invalid JSON.");
        }
        return;
      }
      onInvoke(buildParametersFromFields(fields));
    };

    useImperativeHandle(ref, () => ({ submit }), [
      pendingInvokeId,
      rawMode,
      rawJson,
      fields,
      onInvoke,
    ]);

    const onFieldChange = (name: string, value: unknown) => {
      setFields((previous) =>
        previous.map((item) =>
          item.name === name ? { ...item, value, isSet: true } : item,
        ),
      );
    };

    const onToggleField = (name: string, isSet: boolean) => {
      setFields((previous) =>
        previous.map((item) => (item.name === name ? { ...item, isSet } : item)),
      );
    };

    return (
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        <div className="min-h-0 flex-1 overflow-auto">
          <ToolDetailsAccordion
            description={tool.description}
            descriptionExtra={
              <p className="mt-1 font-mono text-[11px] text-muted-foreground">
                {tool.origin}
              </p>
            }
            inputSchema={tool.inputSchema}
            openSections={openSections}
            onOpenSectionsChange={setOpenSections}
            parameters={
              <>
                <div className="flex items-center justify-end px-3 pb-1">
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="h-7 px-2 text-xs"
                    onClick={() => setRawMode((value) => !value)}
                  >
                    {rawMode ? "Use form" : "Use JSON"}
                  </Button>
                </div>
                {rawMode ? (
                  <div className="space-y-1 px-3 pb-3">
                    <textarea
                      id="webmcp-raw-input"
                      value={rawJson}
                      onChange={(event) => setRawJson(event.target.value)}
                      spellCheck={false}
                      rows={8}
                      className="w-full rounded-md border bg-background p-2 font-mono text-xs"
                      aria-describedby={
                        rawError ? "webmcp-raw-input-error" : undefined
                      }
                    />
                    {rawError ? (
                      <p
                        id="webmcp-raw-input-error"
                        className="text-xs text-destructive"
                      >
                        {rawError}
                      </p>
                    ) : null}
                  </div>
                ) : (
                  <ParametersForm
                    fields={fields}
                    onFieldChange={onFieldChange}
                    onToggleField={onToggleField}
                    onExecute={submit}
                  />
                )}
              </>
            }
          />
        </div>
        {pendingInvokeId ? (
          <div className="flex-shrink-0 border-t border-border px-3 py-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => onCancel(pendingInvokeId)}
            >
              Cancel
            </Button>
          </div>
        ) : null}
      </div>
    );
  },
);
