import { Button } from "../ui/button";
import { ScrollArea } from "../ui/scroll-area";
import { RefreshCw, Play, Save as SaveIcon } from "lucide-react";
import { TruncatedText } from "../ui/truncated-text";
import { ResizablePanel } from "../ui/resizable";
import { Input } from "../ui/input";
import { Textarea } from "../ui/textarea";
import { usePostHog } from "posthog-js/react";
import type { FormField } from "@/lib/tool-form";
import { detectEnvironment, detectPlatform } from "@/logs/PosthogUtils";

interface ParametersPanelProps {
  selectedTool: string;
  toolDescription?: string;
  formFields: FormField[];
  loading: boolean;
  waitingOnElicitation: boolean;
  onExecute: () => void;
  onSave: () => void;
  onFieldChange: (name: string, value: any) => void;
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
          <div className="flex items-center gap-2">
            <Button
              onClick={() => {
                posthog.capture("execute_tool", {
                  location: "parameters_panel",
                  platform: detectPlatform(),
                  environment: detectEnvironment(),
                });
                onExecute();
              }}
              disabled={loading || !selectedTool}
              className="bg-primary hover:bg-primary/90 text-primary-foreground shadow-sm transition-all duration-200 cursor-pointer"
              size="sm"
            >
              {loading ? (
                <>
                  <RefreshCw className="h-3 w-3 mr-1.5 animate-spin cursor-pointer" />
                  <span className="font-mono text-xs">
                    {waitingOnElicitation ? "Waiting..." : "Running"}
                  </span>
                </>
              ) : (
                <>
                  <Play className="h-3 w-3 mr-1.5 cursor-pointer" />
                  <span className="font-mono text-xs">Execute</span>
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
              <SaveIcon className="h-3 w-3 mr-1" />
              <span className="font-mono text-xs">Save</span>
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
                              <div
                                className="w-1.5 h-1.5 bg-amber-400 dark:bg-amber-500 rounded-full"
                                title="Required field"
                              />
                            )}
                          </div>
                          {field.description && (
                            <p className="text-xs text-muted-foreground/80">
                              {field.description}
                            </p>
                          )}
                        </div>
                        <span className="text-[10px] text-muted-foreground font-mono bg-muted/60 px-2 py-1 rounded-md border border-border">
                          {field.type}
                        </span>
                      </div>

                      <div>
                        {field.type === "enum" ? (
                          <select
                            value={field.value}
                            onChange={(e) =>
                              onFieldChange(field.name, e.target.value)
                            }
                            onKeyDown={handleSelectKeyDown}
                            className="w-full h-9 bg-background border border-border rounded px-2 text-xs"
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
                              onChange={(e) =>
                                onFieldChange(field.name, e.target.checked)
                              }
                              className="w-4 h-4 text-primary bg-background border-border rounded focus:ring-ring focus:ring-2"
                            />
                            <span className="text-xs text-foreground font-medium">
                              {field.value ? "Enabled" : "Disabled"}
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
                            placeholder={`Enter ${field.type} as JSON`}
                            className="font-mono text-xs h-20 bg-background border-border hover:border-border/80 focus:border-ring focus:ring-0 resize-none"
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
                            className="bg-background border-border hover:border-border/80 focus:border-ring focus:ring-0 font-medium text-xs"
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
