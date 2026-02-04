import { useCallback, useEffect, useMemo, useState } from "react";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Textarea } from "./ui/textarea";
import { Badge } from "./ui/badge";
import { ScrollArea } from "./ui/scroll-area";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "./ui/select";
import {
  MessageSquare,
  Play,
  RefreshCw,
  ChevronRight,
  PanelLeftClose,
} from "lucide-react";
import { EmptyState } from "./ui/empty-state";
import { ThreePanelLayout } from "./ui/three-panel-layout";
import { JsonEditor } from "@/components/ui/json-editor";
import { MCPServerConfig, type MCPPrompt } from "@mcpjam/sdk";
import {
  getPrompt as getPromptApi,
  listPrompts as listPromptsApi,
} from "@/lib/apis/mcp-prompts-api";
import { SelectedToolHeader } from "./ui-playground/SelectedToolHeader";

interface PromptsTabProps {
  serverConfig?: MCPServerConfig;
  serverName?: string;
}

type PromptArgument = NonNullable<MCPPrompt["arguments"]>[number];

interface FormField {
  name: string;
  type: string;
  description?: string;
  required: boolean;
  value: string | boolean;
  enum?: string[];
  minimum?: number;
  maximum?: number;
}

export function PromptsTab({ serverConfig, serverName }: PromptsTabProps) {
  const [prompts, setPrompts] = useState<MCPPrompt[]>([]);
  const [selectedPrompt, setSelectedPrompt] = useState<string>("");
  const [formFields, setFormFields] = useState<FormField[]>([]);
  const [promptContent, setPromptContent] = useState<any>(null);
  const [loading, setLoading] = useState(false);
  const [fetchingPrompts, setFetchingPrompts] = useState(false);
  const [error, setError] = useState<string>("");
  const [isSidebarVisible, setIsSidebarVisible] = useState(true);

  const selectedPromptData = useMemo(() => {
    return prompts.find((prompt) => prompt.name === selectedPrompt) ?? null;
  }, [prompts, selectedPrompt]);

  useEffect(() => {
    if (serverConfig && serverName) {
      fetchPrompts();
    }
  }, [serverConfig, serverName]);

  useEffect(() => {
    if (selectedPromptData?.arguments) {
      generateFormFields(selectedPromptData.arguments);
    } else {
      setFormFields([]);
    }
  }, [selectedPromptData]);

  const fetchPrompts = async () => {
    if (!serverName) return;

    setFetchingPrompts(true);
    setError("");

    try {
      const serverPrompts = await listPromptsApi(serverName);
      setPrompts(serverPrompts);

      // Clear selection if the selected prompt no longer exists
      if (
        selectedPrompt &&
        !serverPrompts.some((prompt) => prompt.name === selectedPrompt)
      ) {
        setSelectedPrompt("");
        setPromptContent(null);
      }
    } catch (err) {
      const message =
        err instanceof Error ? err.message : `Could not fetch prompts: ${err}`;
      setError(message);
    } finally {
      setFetchingPrompts(false);
    }
  };

  const generateFormFields = (args: PromptArgument[]) => {
    if (!args || args.length === 0) {
      setFormFields([]);
      return;
    }

    const fields: FormField[] = args.map((arg) => ({
      name: arg.name,
      type: "string",
      description: arg.description,
      required: Boolean(arg.required),
      value: "",
    }));

    setFormFields(fields);
  };

  const updateFieldValue = (fieldName: string, value: string | boolean) => {
    setFormFields((prev) =>
      prev.map((field) =>
        field.name === fieldName ? { ...field, value } : field,
      ),
    );
  };

  const buildParameters = useCallback((): Record<string, string> => {
    const params: Record<string, string> = {};
    formFields.forEach((field) => {
      if (
        field.value !== "" &&
        field.value !== null &&
        field.value !== undefined
      ) {
        let processedValue: string;

        if (field.type === "array" || field.type === "object") {
          processedValue =
            typeof field.value === "string"
              ? field.value
              : JSON.stringify(field.value);
        } else if (field.type === "boolean") {
          processedValue = field.value ? "true" : "false";
        } else if (field.type === "number" || field.type === "integer") {
          processedValue = String(field.value);
        } else {
          processedValue = String(field.value);
        }

        params[field.name] = processedValue;
      }
    });
    return params;
  }, [formFields]);

  // Get prompt - can be called with explicit promptName for auto-run on selection
  const getPrompt = useCallback(
    async (promptName?: string, params?: Record<string, string>) => {
      const targetPrompt = promptName ?? selectedPrompt;
      if (!targetPrompt || !serverName) return;

      setLoading(true);
      setError("");

      try {
        const resolvedParams = params ?? buildParameters();
        const data = await getPromptApi(
          serverName,
          targetPrompt,
          resolvedParams,
        );
        setPromptContent(data.content);
      } catch (err) {
        const message =
          err instanceof Error ? err.message : `Error getting prompt: ${err}`;
        setError(message);
      } finally {
        setLoading(false);
      }
    },
    [selectedPrompt, serverName, buildParameters],
  );

  const promptNames = prompts.map((prompt) => prompt.name);

  // Handle Enter key in input fields
  const handleInputKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" && !loading) {
      e.preventDefault();
      getPrompt();
    }
  };

  // Handle Enter key to get prompt globally
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Enter" && !e.shiftKey && selectedPrompt && !loading) {
        const target = e.target as HTMLElement;
        const tagName = target.tagName;
        const isEditable = target.isContentEditable;

        if (tagName === "INPUT" || tagName === "TEXTAREA" || isEditable) {
          return;
        }

        e.preventDefault();
        getPrompt();
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [selectedPrompt, loading, getPrompt]);

  if (!serverConfig || !serverName) {
    return (
      <EmptyState
        icon={MessageSquare}
        title="No Server Selected"
        description="Connect to an MCP server to explore and test its available prompts."
      />
    );
  }

  const sidebarContent = (
    <div className="h-full flex flex-col border-r border-border bg-background">
      {/* App Builder-style Header */}
      <div className="border-b border-border flex-shrink-0">
        <div className="px-2 py-1.5 flex items-center gap-2">
          {/* Title */}
          <div className="flex items-center gap-1.5">
            <span className="px-3 py-1.5 rounded-md text-xs font-medium bg-primary/10 text-primary">
              Prompts
              <span className="ml-1 text-[10px] font-mono opacity-70">
                {promptNames.length}
              </span>
            </span>
          </div>

          {/* Secondary actions */}
          <div className="flex items-center gap-0.5 text-muted-foreground/80">
            <Button
              onClick={fetchPrompts}
              variant="ghost"
              size="sm"
              disabled={fetchingPrompts}
              className="h-7 w-7 p-0"
              title="Refresh prompts"
            >
              <RefreshCw
                className={`h-3.5 w-3.5 ${fetchingPrompts ? "animate-spin" : ""}`}
              />
            </Button>
            <Button
              onClick={() => setIsSidebarVisible(false)}
              variant="ghost"
              size="sm"
              className="h-7 w-7 p-0"
              title="Hide sidebar"
            >
              <PanelLeftClose className="h-3.5 w-3.5" />
            </Button>
          </div>

          {/* Run button */}
          <Button
            onClick={() => getPrompt()}
            disabled={loading || !selectedPrompt}
            size="sm"
            className="h-8 px-3 text-xs ml-auto"
          >
            {loading ? (
              <RefreshCw className="h-3 w-3 animate-spin" />
            ) : (
              <Play className="h-3 w-3" />
            )}
            <span className="ml-1">{loading ? "Loading" : "Run"}</span>
          </Button>
        </div>
      </div>

      {/* Content */}
      {selectedPrompt ? (
        /* Parameters View when prompt is selected */
        <div className="flex-1 flex flex-col min-h-0">
          <SelectedToolHeader
            toolName={selectedPrompt}
            description={selectedPromptData?.description}
            onExpand={() => setSelectedPrompt("")}
            onClear={() => setSelectedPrompt("")}
          />

          <ScrollArea className="flex-1">
            <div className="px-3 py-3">
              {formFields.length === 0 ? (
                <p className="text-xs text-muted-foreground text-center py-8">
                  No parameters required
                </p>
              ) : (
                <div className="space-y-3">
                  {formFields.map((field) => (
                    <div key={field.name} className="space-y-1.5">
                      <div className="flex items-center gap-2">
                        <code className="font-mono text-xs font-medium text-foreground">
                          {field.name}
                        </code>
                        {field.required && (
                          <Badge
                            variant="outline"
                            className="text-[9px] px-1 py-0 border-amber-500/50 text-amber-600 dark:text-amber-400"
                          >
                            required
                          </Badge>
                        )}
                      </div>
                      {field.description && (
                        <p className="text-[10px] text-muted-foreground leading-relaxed">
                          {field.description}
                        </p>
                      )}
                      <div className="pt-0.5">
                        {field.type === "enum" ? (
                          <Select
                            value={String(field.value)}
                            onValueChange={(value) =>
                              updateFieldValue(field.name, value)
                            }
                          >
                            <SelectTrigger className="w-full h-8 bg-background border-border text-xs">
                              <SelectValue placeholder="Select an option" />
                            </SelectTrigger>
                            <SelectContent>
                              {field.enum?.map((option) => (
                                <SelectItem key={option} value={option}>
                                  {option}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        ) : field.type === "boolean" ? (
                          <div className="flex items-center gap-2 h-8">
                            <input
                              type="checkbox"
                              checked={field.value === true}
                              onChange={(e) =>
                                updateFieldValue(field.name, e.target.checked)
                              }
                              className="w-4 h-4 rounded border-border accent-primary"
                            />
                            <span className="text-xs text-foreground">
                              {field.value === true ? "true" : "false"}
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
                              updateFieldValue(field.name, e.target.value)
                            }
                            placeholder={`Enter ${field.type} as JSON`}
                            className="font-mono text-xs min-h-[80px] bg-background border-border resize-y"
                          />
                        ) : (
                          <Input
                            type={
                              field.type === "number" ||
                              field.type === "integer"
                                ? "number"
                                : "text"
                            }
                            value={String(field.value)}
                            onChange={(e) =>
                              updateFieldValue(field.name, e.target.value)
                            }
                            onKeyDown={handleInputKeyDown}
                            placeholder={`Enter ${field.name}`}
                            className="bg-background border-border text-xs h-8"
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
      ) : (
        /* Prompts List when no prompt is selected */
        <div className="flex-1 overflow-hidden">
          <ScrollArea className="h-full">
            <div className="p-2">
              {fetchingPrompts ? (
                <div className="flex flex-col items-center justify-center py-16 text-center">
                  <div className="w-8 h-8 bg-muted rounded-full flex items-center justify-center mb-3">
                    <RefreshCw className="h-4 w-4 text-muted-foreground animate-spin" />
                  </div>
                  <p className="text-xs text-muted-foreground font-semibold mb-1">
                    Loading prompts...
                  </p>
                  <p className="text-xs text-muted-foreground/70">
                    Fetching available prompts from server
                  </p>
                </div>
              ) : promptNames.length === 0 ? (
                <div className="text-center py-8">
                  <p className="text-sm text-muted-foreground">
                    No prompts available
                  </p>
                </div>
              ) : (
                <div className="space-y-1">
                  {prompts.map((prompt) => {
                    const displayTitle = prompt.title ?? prompt.name;
                    return (
                      <div
                        key={prompt.name}
                        className="cursor-pointer transition-all duration-200 hover:bg-muted/30 dark:hover:bg-muted/50 p-3 rounded-md mx-2 hover:shadow-sm"
                        onClick={() => {
                          setSelectedPrompt(prompt.name);
                          // Auto-run if no arguments required
                          if (
                            !prompt.arguments ||
                            prompt.arguments.length === 0
                          ) {
                            getPrompt(prompt.name, {});
                          }
                        }}
                      >
                        <div className="flex items-start gap-3">
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2 mb-1">
                              <code className="font-mono text-xs font-medium text-foreground bg-muted px-1.5 py-0.5 rounded border border-border">
                                {prompt.name}
                              </code>
                              {prompt.title && (
                                <span className="text-xs font-semibold text-foreground">
                                  {displayTitle}
                                </span>
                              )}
                            </div>
                            {prompt.description && (
                              <p className="text-xs mt-2 line-clamp-2 leading-relaxed text-muted-foreground">
                                {prompt.description}
                              </p>
                            )}
                          </div>
                          <ChevronRight className="h-3 w-3 text-muted-foreground flex-shrink-0 mt-1" />
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </ScrollArea>
        </div>
      )}
    </div>
  );

  const centerContent = (
    <div className="h-full flex flex-col bg-background">
      <div className="flex-1 min-h-0 flex flex-col">
        {error ? (
          <div className="p-4">
            <div className="p-3 bg-destructive/10 border border-destructive/20 rounded text-destructive text-xs font-medium">
              {error}
            </div>
          </div>
        ) : promptContent ? (
          <div className="flex-1 min-h-0 p-4 flex flex-col">
            {typeof promptContent === "string" ? (
              <pre className="flex-1 min-h-0 whitespace-pre-wrap text-xs font-mono bg-muted/30 p-4 rounded-md border border-border overflow-auto">
                {promptContent}
              </pre>
            ) : (
              <div className="flex-1 min-h-0">
                <JsonEditor
                  value={promptContent}
                  readOnly
                  showToolbar={false}
                  height="100%"
                />
              </div>
            )}
          </div>
        ) : (
          <div className="h-full flex items-center justify-center">
            <div className="text-center">
              <div className="w-12 h-12 bg-muted rounded-full flex items-center justify-center mx-auto mb-3">
                <MessageSquare className="h-5 w-5 text-muted-foreground" />
              </div>
              <p className="text-xs font-semibold text-foreground mb-1">
                {selectedPrompt ? "Response" : "No selection"}
              </p>
              <p className="text-xs text-muted-foreground font-medium">
                {selectedPrompt
                  ? formFields.length > 0
                    ? "Fill in parameters and click Run"
                    : "Loading..."
                  : "Select a prompt from the sidebar"}
              </p>
            </div>
          </div>
        )}
      </div>
    </div>
  );

  return (
    <ThreePanelLayout
      id="prompts"
      sidebar={sidebarContent}
      content={centerContent}
      sidebarVisible={isSidebarVisible}
      onSidebarVisibilityChange={setIsSidebarVisible}
      sidebarTooltip="Show prompts sidebar"
      serverName={serverName}
    />
  );
}
