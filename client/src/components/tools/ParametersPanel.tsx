import { Button } from "../ui/button";
import { ScrollArea } from "../ui/scroll-area";
import { RefreshCw, Play, Save as SaveIcon, Clock } from "lucide-react";
import { TruncatedText } from "../ui/truncated-text";
import { ResizablePanel } from "../ui/resizable";
import { Input } from "../ui/input";
import { Textarea } from "../ui/textarea";
import { usePostHog } from "posthog-js/react";
import type { FormField } from "@/lib/tool-form";
import { detectEnvironment, detectPlatform } from "@/lib/PosthogUtils";

interface ParametersPanelProps {
  selectedTool: string;
  toolDescription?: string;
  formFields: FormField[];
  loading: boolean;
  waitingOnElicitation: boolean;
  onExecute: () => void;
  onSave: () => void;
  onFieldChange: (name: string, value: any) => void;
  onToggleField?: (name: string, isSet: boolean) => void;
  executeAsTask?: boolean;
  onExecuteAsTaskChange?: (value: boolean) => void;
  /** If true, tool requires task execution (MCP Tasks spec) */
  taskRequired?: boolean;
  /** TTL for task execution in milliseconds (MCP Tasks spec 2025-11-25) */
  taskTtl?: number;
  onTaskTtlChange?: (value: number) => void;
  /** Whether server declares tasks.requests.tools.call capability */
  serverSupportsTaskToolCalls?: boolean;
}

export function ParametersPanel({
  selectedTool,
  toolDescription,
  formFields,
  loading,
  waitingOnElicitation,
  onExecute,
  onSave,
  onFieldChange,
  onToggleField,
  executeAsTask,
  onExecuteAsTaskChange,
  taskRequired,
  taskTtl,
  onTaskTtlChange,
  serverSupportsTaskToolCalls,
}: ParametersPanelProps) {
  const posthog = usePostHog();

  // Handle Enter key in input fields
  const handleInputKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" && !loading) {
      e.preventDefault();
      onExecute();
    }
  };

  // Handle Enter key in select fields
  const handleSelectKeyDown = (e: React.KeyboardEvent<HTMLSelectElement>) => {
    if (e.key === "Enter" && !loading) {
      e.preventDefault();
      onExecute();
    }
  };

  return (
    <ResizablePanel defaultSize={70} minSize={50}>
      <div className="h-full flex flex-col bg-background">
        <div className="flex items-center justify-between px-6 py-5 border-b border-border bg-background">
          <div className="space-y-2">
            <div className="flex items-center gap-3">
              <code className="font-mono font-semibold text-foreground bg-muted px-2 py-1 rounded-md border border-border text-xs">
                {selectedTool}
              </code>
            </div>
          </div>
          <div className="flex items-center gap-3">
            {/* Task execution option - show if server and tool support it */}
            {taskRequired ? (
              // Tool requires task execution (MCP Tasks spec)
              <div className="flex items-center gap-2">
                <span
                  className="flex items-center gap-1.5 text-[11px] text-amber-600 dark:text-amber-400"
                  title="This tool requires background task execution"
                >
                  <Clock className="h-3 w-3" />
                  <span>Task required</span>
                </span>
                {/* TTL input for required tasks */}
                {onTaskTtlChange && (
                  <div className="flex items-center gap-1">
                    <Input
                      type="number"
                      min={0}
                      defaultValue={taskTtl ?? 0}
                      key={`ttl-req-${taskTtl}`}
                      onBlur={(e) =>
                        onTaskTtlChange(parseInt(e.target.value) || 0)
                      }
                      className="w-20 h-6 text-[10px] px-1.5 [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
                      title="TTL in milliseconds (0 = no expiration)"
                    />
                    <span className="text-[10px] text-muted-foreground">
                      ms TTL
                    </span>
                  </div>
                )}
              </div>
            ) : onExecuteAsTaskChange ? (
              <div className="flex items-center gap-2">
                <label
                  className="flex items-center gap-1.5 text-[11px] text-muted-foreground cursor-pointer hover:text-foreground transition-colors"
                  title={
                    serverSupportsTaskToolCalls
                      ? "Execute as a background task (MCP Tasks)"
                      : "Execute as a background task (server may not support tasks)"
                  }
                >
                  <input
                    type="checkbox"
                    checked={executeAsTask ?? false}
                    onChange={(e) => onExecuteAsTaskChange(e.target.checked)}
                    className="w-3.5 h-3.5 rounded border-border accent-primary cursor-pointer"
                  />
                  <Clock
                    className={`h-3 w-3 ${serverSupportsTaskToolCalls === false ? "text-amber-500" : ""}`}
                  />
                  <span>Task</span>
                </label>
                {/* TTL input - show when task execution is enabled */}
                {executeAsTask && onTaskTtlChange && (
                  <div className="flex items-center gap-1">
                    <Input
                      type="number"
                      min={0}
                      defaultValue={taskTtl ?? 0}
                      key={`ttl-opt-${taskTtl}`}
                      onBlur={(e) =>
                        onTaskTtlChange(parseInt(e.target.value) || 0)
                      }
                      className="w-20 h-6 text-[10px] px-1.5 [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
                      title="TTL in milliseconds (0 = no expiration)"
                    />
                    <span className="text-[10px] text-muted-foreground">
                      ms TTL
                    </span>
                  </div>
                )}
              </div>
            ) : null}
            <Button
              onClick={() => {
                posthog.capture("execute_tool", {
                  location: "parameters_panel",
                  platform: detectPlatform(),
                  environment: detectEnvironment(),
                  as_task: executeAsTask ?? false,
                });
                onExecute();
              }}
              disabled={loading || !selectedTool}
              className="bg-primary hover:bg-primary/90 text-primary-foreground shadow-sm transition-all duration-200 cursor-pointer"
              size="sm"
            >
              {loading ? (
                <>
                  <RefreshCw className="h-3 w-3 animate-spin" />
                  {waitingOnElicitation ? "Waiting..." : "Running"}
                </>
              ) : (
                <>
                  <Play className="h-3 w-3" />
                  Execute
                </>
              )}
            </Button>
            <Button
              onClick={() => {
                posthog.capture("save_tool_button_clicked", {
                  location: "parameters_panel",
                  platform: detectPlatform(),
                  environment: detectEnvironment(),
                });
                onSave();
              }}
              variant="outline"
              size="sm"
              disabled={!selectedTool}
            >
              <SaveIcon className="h-3 w-3" />
              Save
            </Button>
          </div>
        </div>

        {toolDescription && (
          <div className="px-6 py-4 bg-muted/50 border-b border-border">
            <TruncatedText
              text={toolDescription}
              title={selectedTool}
              maxLength={400}
            />
          </div>
        )}

        <div className="flex-1 overflow-hidden">
          <ScrollArea className="h-full">
            <div className="px-6 py-6">
              {formFields.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-16 text-center">
                  <div className="w-10 h-10 bg-muted rounded-full flex items-center justify-center mb-3">
                    <Play className="h-4 w-4 text-muted-foreground" />
                  </div>
                  <p className="text-xs text-muted-foreground font-semibold mb-1">
                    No parameters required
                  </p>
                  <p className="text-xs text-muted-foreground/70">
                    This tool can be executed directly
                  </p>
                </div>
              ) : (
                <div className="space-y-8">
                  {formFields.map((field) => (
                    <div key={field.name} className="group">
                      <div className="flex items-start justify-between mb-3">
                        <div className="space-y-1">
                          <div className="flex items-center gap-3">
                            <code className="font-mono text-xs font-semibold text-foreground bg-muted px-1.5 py-0.5 rounded border border-border">
                              {field.name}
                            </code>
                            {field.required && (
                              <span
                                className="text-[10px] font-mono uppercase tracking-wide text-amber-600 dark:text-amber-400"
                                title="Required field"
                              >
                                required
                              </span>
                            )}
                            {!field.required && (
                              <label className="flex items-center gap-1 text-[10px] text-muted-foreground">
                                <input
                                  type="checkbox"
                                  checked={!field.isSet}
                                  onChange={(e) =>
                                    onToggleField?.(
                                      field.name,
                                      !e.target.checked,
                                    )
                                  }
                                  className="w-3 h-3 rounded border-border accent-primary"
                                />
                                <span>undefined</span>
                              </label>
                            )}
                          </div>
                          {field.description && (
                            <p className="text-xs text-muted-foreground/80">
                              {field.description}
                            </p>
                          )}
                          {!field.required && !field.isSet && (
                            <p className="text-[10px] text-muted-foreground/80 italic">
                              Value is{" "}
                              <span className="font-mono">undefined</span> and
                              will be omitted from the request.
                            </p>
                          )}
                        </div>
                        <div className="flex flex-col items-end gap-1">
                          <span className="text-[10px] text-muted-foreground font-mono bg-muted/60 px-2 py-1 rounded-md border border-border">
                            {field.type}
                          </span>
                        </div>
                      </div>

                      <div>
                        {field.type === "enum" ? (
                          <select
                            value={field.value}
                            onChange={(e) =>
                              onFieldChange(field.name, e.target.value)
                            }
                            onKeyDown={handleSelectKeyDown}
                            disabled={!field.required && !field.isSet}
                            className="w-full h-9 bg-background border border-border rounded px-2 text-xs disabled:cursor-not-allowed disabled:bg-muted/40"
                          >
                            {field.enum?.map((v) => (
                              <option key={v} value={v}>
                                {v}
                              </option>
                            ))}
                          </select>
                        ) : field.type === "boolean" ? (
                          <div className="flex items-center space-x-3 py-2">
                            <input
                              type="checkbox"
                              checked={field.value}
                              disabled={!field.required && !field.isSet}
                              onChange={(e) =>
                                onFieldChange(field.name, e.target.checked)
                              }
                              className="w-4 h-4 text-primary bg-background border-border rounded focus:ring-ring focus:ring-2 disabled:cursor-not-allowed disabled:opacity-60"
                            />
                            <span className="text-xs text-foreground font-medium">
                              {!field.required && !field.isSet
                                ? "Undefined"
                                : field.value
                                  ? "Enabled"
                                  : "Disabled"}
                            </span>
                          </div>
                        ) : field.type === "array" ||
                          field.type === "object" ? (
                          <Textarea
                            value={
                              typeof field.value === "string"
                                ? field.value
                                : JSON.stringify(field.value, null, 2)
                            }
                            onChange={(e) =>
                              onFieldChange(field.name, e.target.value)
                            }
                            placeholder={
                              !field.required && !field.isSet
                                ? "Value is undefined; enable this field to provide JSON"
                                : `Enter ${field.type} as JSON`
                            }
                            disabled={!field.required && !field.isSet}
                            className="font-mono text-xs h-20 bg-background border-border hover:border-border/80 focus:border-ring focus:ring-0 resize-none disabled:cursor-not-allowed disabled:bg-muted/40"
                          />
                        ) : (
                          <Input
                            type={
                              field.type === "number" ||
                              field.type === "integer"
                                ? "number"
                                : "text"
                            }
                            value={field.value}
                            onChange={(e) =>
                              onFieldChange(field.name, e.target.value)
                            }
                            onKeyDown={handleInputKeyDown}
                            placeholder={`Enter ${field.name}`}
                            disabled={!field.required && !field.isSet}
                            className="bg-background border-border hover:border-border/80 focus:border-ring focus:ring-0 font-medium text-xs disabled:cursor-not-allowed disabled:bg-muted/40"
                          />
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </ScrollArea>
        </div>
      </div>
    </ResizablePanel>
  );
}
