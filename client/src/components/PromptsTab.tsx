import { useEffect, useMemo, useState } from "react";
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
  ResizablePanelGroup,
  ResizablePanel,
  ResizableHandle,
} from "./ui/resizable";
import { MessageSquare, Play, RefreshCw, ChevronRight } from "lucide-react";
import { EmptyState } from "./ui/empty-state";
import JsonView from "react18-json-view";
import "react18-json-view/src/style.css";
import { MCPServerConfig, type MCPPrompt } from "@/sdk";
import {
  getPrompt as getPromptApi,
  listPrompts as listPromptsApi,
} from "@/lib/mcp-prompts-api";
import { LoggerView } from "./logging/logger-view";

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

      if (serverPrompts.length === 0) {
        setSelectedPrompt("");
        setPromptContent(null);
      } else if (
        !serverPrompts.some((prompt) => prompt.name === selectedPrompt)
      ) {
        setSelectedPrompt(serverPrompts[0].name);
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
      type: "string", // Default to string for now, could be enhanced based on arg type
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

  const buildParameters = (): Record<string, string> => {
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
  };

  const getPrompt = async () => {
    if (!selectedPrompt || !serverName) return;

    setLoading(true);
    setError("");

    try {
      const params = buildParameters();
      const data = await getPromptApi(serverName, selectedPrompt, params);
      setPromptContent(data.content);
    } catch (err) {
      const message =
        err instanceof Error ? err.message : `Error getting prompt: ${err}`;
      setError(message);
    } finally {
      setLoading(false);
    }
  };

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
        // Don't trigger if user is typing in an input, textarea, or contenteditable
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
  }, [selectedPrompt, loading]);

  if (!serverConfig || !serverName) {
    return (
      <EmptyState
        icon={MessageSquare}
        title="No Server Selected"
        description="Connect to an MCP server to explore and test its available prompts."
      />
    );
  }

  return (
    <div className="h-[calc(100vh-120px)] flex flex-col">
      <ResizablePanelGroup direction="vertical" className="flex-1">
        {/* Top Section - Prompts and Parameters */}
        <ResizablePanel defaultSize={70} minSize={30}>
          <ResizablePanelGroup direction="horizontal" className="h-full">
            {/* Left Panel - Prompts List */}
            <ResizablePanel defaultSize={30} minSize={20} maxSize={50}>
              <div className="h-full flex flex-col border-r border-border bg-background">
                {/* Header */}
                <div className="flex items-center justify-between px-4 py-4 border-b border-border bg-background">
                  <div className="flex items-center gap-3">
                    <MessageSquare className="h-3 w-3 text-muted-foreground" />
                    <h2 className="text-xs font-semibold text-foreground">
                      Prompts
                    </h2>
                    <Badge variant="secondary" className="text-xs font-mono">
                      {promptNames.length}
                    </Badge>
                  </div>
                  <Button
                    onClick={fetchPrompts}
                    variant="ghost"
                    size="sm"
                    disabled={fetchingPrompts}
                  >
                    <RefreshCw
                      className={`h-3 w-3 ${fetchingPrompts ? "animate-spin" : ""} cursor-pointer`}
                    />
                  </Button>
                </div>

                {/* Prompts List */}
                <div className="flex-1 overflow-hidden">
                  <ScrollArea className="h-full">
                    <div className="p-2">
                      {fetchingPrompts ? (
                        <div className="flex flex-col items-center justify-center py-16 text-center">
                          <div className="w-8 h-8 bg-muted rounded-full flex items-center justify-center mb-3">
                            <RefreshCw className="h-4 w-4 text-muted-foreground animate-spin cursor-pointer" />
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
                            const isSelected = selectedPrompt === prompt.name;
                            const displayTitle = prompt.title ?? prompt.name;
                            return (
                              <div
                                key={prompt.name}
                                className={`cursor-pointer transition-all duration-200 hover:bg-muted/30 dark:hover:bg-muted/50 p-3 rounded-md mx-2 ${
                                  isSelected
                                    ? "bg-muted/50 dark:bg-muted/50 shadow-sm border border-border ring-1 ring-ring/20"
                                    : "hover:shadow-sm"
                                }`}
                                onClick={() => {
                                  setSelectedPrompt(prompt.name);
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
              </div>
            </ResizablePanel>

            <ResizableHandle withHandle />

            {/* Right Panel - Parameters */}
            <ResizablePanel defaultSize={70} minSize={50}>
              <div className="h-full flex flex-col bg-background">
                {selectedPrompt ? (
                  <>
                    {/* Header */}
                    <div className="flex items-center justify-between px-6 py-5 border-b border-border bg-background">
                      <div className="space-y-2">
                        <div className="flex items-center gap-3">
                          <code className="font-mono font-semibold text-foreground bg-muted px-2 py-1 rounded-md border border-border text-xs">
                            {selectedPrompt}
                          </code>
                        </div>
                      </div>
                      <Button
                        onClick={getPrompt}
                        disabled={loading || !selectedPrompt}
                        className="bg-primary hover:bg-primary/90 text-primary-foreground shadow-sm transition-all duration-200 cursor-pointer"
                        size="sm"
                      >
                        {loading ? (
                          <>
                            <RefreshCw className="h-3 w-3 mr-1.5 animate-spin cursor-pointer" />
                            <span className="font-mono text-xs">Loading</span>
                          </>
                        ) : (
                          <>
                            <Play className="h-3 w-3 mr-1.5 cursor-pointer" />
                            <span className="font-mono text-xs">
                              Get Prompt
                            </span>
                          </>
                        )}
                      </Button>
                    </div>

                    {/* Description */}
                    {selectedPromptData?.description && (
                      <div className="px-6 py-4 bg-muted/50 border-b border-border">
                        <p className="text-xs text-muted-foreground leading-relaxed font-medium">
                          {selectedPromptData.description}
                        </p>
                      </div>
                    )}

                    {/* Parameters */}
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
                                This prompt can be retrieved directly
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
                                        <p className="text-xs text-muted-foreground leading-relaxed max-w-md font-medium">
                                          {field.description}
                                        </p>
                                      )}
                                    </div>
                                    <Badge
                                      variant="secondary"
                                      className="text-xs font-mono font-medium"
                                    >
                                      {field.type}
                                    </Badge>
                                  </div>

                                  <div className="space-y-2">
                                    {field.type === "enum" ? (
                                      <Select
                                        value={String(field.value)}
                                        onValueChange={(value) =>
                                          updateFieldValue(field.name, value)
                                        }
                                      >
                                        <SelectTrigger className="w-full bg-background border-border hover:border-border/80 focus:border-ring focus:ring-0 font-medium text-xs">
                                          <SelectValue
                                            placeholder="Select an option"
                                            className="font-mono text-xs"
                                          />
                                        </SelectTrigger>
                                        <SelectContent>
                                          {field.enum?.map((option) => (
                                            <SelectItem
                                              key={option}
                                              value={option}
                                              className="font-mono text-xs"
                                            >
                                              {option}
                                            </SelectItem>
                                          ))}
                                        </SelectContent>
                                      </Select>
                                    ) : field.type === "boolean" ? (
                                      <div className="flex items-center space-x-3 py-2">
                                        <input
                                          type="checkbox"
                                          checked={field.value === true}
                                          onChange={(e) =>
                                            updateFieldValue(
                                              field.name,
                                              e.target.checked,
                                            )
                                          }
                                          className="w-4 h-4 text-primary bg-background border-border rounded focus:ring-ring focus:ring-2"
                                        />
                                        <span className="text-xs text-foreground font-medium">
                                          {field.value === true
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
                                            : JSON.stringify(
                                                field.value,
                                                null,
                                                2,
                                              )
                                        }
                                        onChange={(e) =>
                                          updateFieldValue(
                                            field.name,
                                            e.target.value,
                                          )
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
                                        value={String(field.value)}
                                        onChange={(e) =>
                                          updateFieldValue(
                                            field.name,
                                            e.target.value,
                                          )
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
                  </>
                ) : (
                  <div className="h-full flex items-center justify-center">
                    <div className="text-center">
                      <div className="w-12 h-12 bg-muted rounded-full flex items-center justify-center mx-auto mb-3">
                        <MessageSquare className="h-5 w-5 text-muted-foreground" />
                      </div>
                      <p className="text-xs font-semibold text-foreground mb-1">
                        Select a prompt
                      </p>
                      <p className="text-xs text-muted-foreground font-medium">
                        Choose a prompt from the left to view details
                      </p>
                    </div>
                  </div>
                )}
              </div>
            </ResizablePanel>
          </ResizablePanelGroup>
        </ResizablePanel>

        <ResizableHandle withHandle />

        {/* Bottom Panel - JSON-RPC Logger and Results */}
        <ResizablePanel defaultSize={30} minSize={15} maxSize={70}>
          <ResizablePanelGroup direction="horizontal" className="h-full">
            <ResizablePanel defaultSize={40} minSize={10}>
              <LoggerView serverIds={serverName ? [serverName] : undefined} />
            </ResizablePanel>
            <ResizableHandle withHandle />
            <ResizablePanel defaultSize={60} minSize={30}>
              <div className="h-full flex flex-col border-t border-border bg-background break-all">
                {/* Header */}
                <div className="flex items-center justify-between p-4 border-b border-border">
                  <h2 className="text-xs font-semibold text-foreground">
                    Prompt Content
                  </h2>
                </div>

                {/* Content */}
                <div className="flex-1 overflow-hidden">
                  {error ? (
                    <div className="p-4">
                      <div className="p-3 bg-destructive/10 border border-destructive/20 rounded text-destructive text-xs font-medium">
                        {error}
                      </div>
                    </div>
                  ) : promptContent ? (
                    <ScrollArea className="h-full">
                      <div className="p-4">
                        {typeof promptContent === "string" ? (
                          <pre className="whitespace-pre-wrap text-xs font-mono bg-muted p-4 rounded-md border border-border">
                            {promptContent}
                          </pre>
                        ) : (
                          <JsonView
                            src={promptContent}
                            dark={true}
                            theme="atom"
                            enableClipboard={true}
                            displaySize={false}
                            collapseStringsAfterLength={100}
                            style={{
                              fontSize: "12px",
                              fontFamily:
                                "ui-monospace, SFMono-Regular, 'SF Mono', monospace",
                              backgroundColor: "hsl(var(--background))",
                              padding: "16px",
                              borderRadius: "8px",
                              border: "1px solid hsl(var(--border))",
                            }}
                          />
                        )}
                      </div>
                    </ScrollArea>
                  ) : (
                    <div className="flex items-center justify-center h-full">
                      <p className="text-xs text-muted-foreground font-medium">
                        Get a prompt to see its content here
                      </p>
                    </div>
                  )}
                </div>
              </div>
            </ResizablePanel>
          </ResizablePanelGroup>
        </ResizablePanel>
      </ResizablePanelGroup>
    </div>
  );
}
