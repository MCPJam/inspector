import { useEffect, useMemo, useState } from "react";
import { Button } from "@mcpjam/design-system/button";
import { Input } from "@mcpjam/design-system/input";
import { Label } from "@mcpjam/design-system/label";
import {
  generateFormFieldsFromSchema,
  buildParametersFromFields,
  type FormField,
} from "@/lib/tool-form";
import type {
  WebMcpActivityEntry,
  WebMcpToolDescriptor,
} from "@/shared/webmcp-inspector-protocol";

export interface ToolInvokePaneProps {
  tool: WebMcpToolDescriptor | undefined;
  /** The most recent settled result for this tool, if any. */
  lastResult:
    Extract<WebMcpActivityEntry, { kind: "invocation_settled" }> | undefined;
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
export function ToolInvokePane({
  tool,
  lastResult,
  pendingInvokeId,
  onInvoke,
  onCancel,
}: ToolInvokePaneProps) {
  const [fields, setFields] = useState<FormField[]>([]);
  const [rawMode, setRawMode] = useState(false);
  const [rawJson, setRawJson] = useState("{}");
  const [rawError, setRawError] = useState<string | undefined>();

  useEffect(() => {
    const next = generateFormFieldsFromSchema(tool?.inputSchema);
    setFields(next);
    setRawJson("{}");
    setRawError(undefined);
    // A schema with no describable properties has nothing to render as a form,
    // so those tools start in raw mode rather than showing an empty one.
    setRawMode(Boolean(tool) && next.length === 0);
    // Keyed on the tool's stable identity ALONE. The store replaces `tools`
    // wholesale on every frame, so `tool` and `tool.inputSchema` are new object
    // identities each time the page re-registers — depending on them would wipe
    // whatever the user was typing, and revert a deliberate "Use JSON" choice,
    // every time the page touched its registry.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tool?.toolKey]);

  const schemaText = useMemo(
    () => (tool?.inputSchema ? JSON.stringify(tool.inputSchema, null, 2) : ""),
    [tool?.inputSchema],
  );

  if (!tool) {
    return (
      <p className="p-4 text-sm text-muted-foreground">
        Select a tool to inspect its schema and invoke it.
      </p>
    );
  }

  const submit = () => {
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

  return (
    <div className="flex flex-col gap-4 p-4 overflow-auto">
      <header className="space-y-1">
        <h2 className="font-mono text-sm">{tool.name}</h2>
        <p className="text-xs text-muted-foreground">{tool.origin}</p>
        {tool.description ? (
          <p className="text-sm text-muted-foreground">{tool.description}</p>
        ) : null}
      </header>

      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <Label
            htmlFor="webmcp-raw-input"
            className="text-xs uppercase tracking-wide text-muted-foreground"
          >
            Input
          </Label>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => setRawMode((value) => !value)}
          >
            {rawMode ? "Use form" : "Use JSON"}
          </Button>
        </div>

        {rawMode ? (
          <div className="space-y-1">
            <textarea
              id="webmcp-raw-input"
              value={rawJson}
              onChange={(event) => setRawJson(event.target.value)}
              spellCheck={false}
              rows={8}
              className="w-full rounded-md border bg-background p-2 font-mono text-xs"
              aria-describedby={rawError ? "webmcp-raw-input-error" : undefined}
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
        ) : fields.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            This tool takes no parameters.
          </p>
        ) : (
          <div className="space-y-3">
            {fields.map((field, index) => (
              <div key={field.name} className="space-y-1">
                <Label
                  htmlFor={`webmcp-field-${field.name}`}
                  className="text-xs"
                >
                  {field.name}
                  {field.required ? (
                    <span className="text-destructive"> *</span>
                  ) : null}
                  <span className="ml-2 font-normal text-muted-foreground">
                    {field.type}
                  </span>
                </Label>
                {field.description ? (
                  <p className="text-xs text-muted-foreground">
                    {field.description}
                  </p>
                ) : null}
                <Input
                  id={`webmcp-field-${field.name}`}
                  value={field.value ?? ""}
                  onChange={(event) =>
                    setFields((previous) =>
                      previous.map((item, itemIndex) =>
                        itemIndex === index
                          ? { ...item, value: event.target.value, isSet: true }
                          : item,
                      ),
                    )
                  }
                />
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="flex gap-2">
        <Button
          type="button"
          onClick={submit}
          disabled={Boolean(pendingInvokeId)}
        >
          {pendingInvokeId ? "Running…" : "Invoke"}
        </Button>
        {pendingInvokeId ? (
          <Button
            type="button"
            variant="outline"
            onClick={() => onCancel(pendingInvokeId)}
          >
            Cancel
          </Button>
        ) : null}
      </div>

      {lastResult ? <InvocationResult result={lastResult} /> : null}

      {schemaText ? (
        <details className="text-xs">
          <summary className="cursor-pointer text-muted-foreground">
            Input schema
          </summary>
          <pre className="mt-2 overflow-auto rounded-md border bg-muted/40 p-2">
            {schemaText}
          </pre>
        </details>
      ) : null}
    </div>
  );
}

function InvocationResult({
  result,
}: {
  result: Extract<WebMcpActivityEntry, { kind: "invocation_settled" }>;
}) {
  const failed = result.state !== "succeeded";
  return (
    <section className="space-y-1">
      <h3 className="text-xs uppercase tracking-wide text-muted-foreground">
        Result · {result.state} · {result.durationMs}ms
      </h3>
      {failed ? (
        <p className="text-sm text-destructive">
          {result.errorMessage ?? "The tool did not complete."}
        </p>
      ) : (
        <>
          {/* Rendered as text, never as markup: this is output from a page we
              do not control, and a tool result is not a place to execute it. */}
          <pre className="max-h-80 overflow-auto rounded-md border bg-muted/40 p-2 text-xs whitespace-pre-wrap break-words">
            {typeof result.output === "string"
              ? result.output
              : JSON.stringify(result.output, null, 2)}
          </pre>
          <p className="text-[11px] text-muted-foreground">
            Output comes from the page and is not trusted.
            {result.outputTruncated
              ? result.outputBytes
                ? ` Truncated — ${result.outputBytes} bytes total.`
                : " Truncated."
              : ""}
          </p>
        </>
      )}
    </section>
  );
}
