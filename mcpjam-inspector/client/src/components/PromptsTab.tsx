import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@mcpjam/design-system/button";
import { Input } from "@mcpjam/design-system/input";
import { Textarea } from "@mcpjam/design-system/textarea";
import { Badge } from "@mcpjam/design-system/badge";
import { ScrollArea } from "@mcpjam/design-system/scroll-area";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@mcpjam/design-system/select";
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
import { extractDisplayFromValue } from "@/components/chat-v2/shared/tool-result-text";
import type { MCPPrompt, MCPServerConfig } from "@mcpjam/sdk/browser";
import {
  getPrompt as getPromptApi,
  listPrompts as listPromptsApi,
} from "@/lib/apis/mcp-prompts-api";
import {
  CacheProvenanceBadge,
  type ServedFromCache,
} from "@/components/ui/cache-provenance-badge";
import { SelectedToolHeader } from "./ui-playground/SelectedToolHeader";
import type { ConnectionStatus } from "@/state/app-types";
import { boundedJsonByteLength } from "@/lib/webmcp/bounded-size";
import { useSurfaceAgentBridge } from "@/lib/webmcp/use-surface-agent-bridge";
import { createInspectorCommandClientError } from "@/lib/inspector-command-handlers";
import { clampText } from "@/lib/webmcp/groups/shared";
import type { GetPromptInspectorCommand } from "@/shared/inspector-command.js";

/** Cap the list of prompts a snapshot enumerates (names/titles only). */
const PROMPT_SNAPSHOT_MAX_ITEMS = 30;
/** Cap how many rendered messages a get returns to the transcript. */
const PROMPT_MESSAGE_MAX_BLOCKS = 20;

/**
 * Build a transcript-safe view of a rendered prompt: each message's text is
 * capped with the group's `clampText`; non-text parts are never inlined
 * (metadata only). The whole tool result is additionally clamped by
 * `fromActionResult` in the group, so this is the inner, per-message bound.
 */
function capPromptContentForTranscript(content: unknown): {
  description?: string;
  messages: unknown[];
  truncated: boolean;
} {
  const src = content as any;
  const messages = Array.isArray(src?.messages) ? (src.messages as any[]) : [];
  let truncated = false;
  const out = messages.slice(0, PROMPT_MESSAGE_MAX_BLOCKS).map((m) => {
    const part = m?.content;
    if (part && typeof part.text === "string") {
      const capped = clampText(part.text);
      if (capped !== part.text) truncated = true;
      return { role: m?.role, type: part.type ?? "text", text: capped };
    }
    return {
      role: m?.role,
      type: part?.type ?? "unknown",
      note: "Non-text content omitted for the transcript.",
    };
  });
  if (messages.length > PROMPT_MESSAGE_MAX_BLOCKS) truncated = true;
  let description: string | undefined;
  if (typeof src?.description === "string") {
    description = clampText(src.description);
    // A clamped description is also truncation — flag it so the agent doesn't
    // read `truncated: false` and treat the shortened text as complete.
    if (description !== src.description) truncated = true;
  }
  return {
    ...(description !== undefined ? { description } : {}),
    messages: out,
    truncated,
  };
}

interface PromptsTabProps {
  serverConfig?: MCPServerConfig;
  serverName?: string;
  serverConnectionStatus?: ConnectionStatus;
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

export function PromptsTab({
  serverConfig,
  serverName,
  serverConnectionStatus,
}: PromptsTabProps) {
  const [prompts, setPrompts] = useState<MCPPrompt[]>([]);
  const [selectedPrompt, setSelectedPrompt] = useState<string>("");
  const [formFields, setFormFields] = useState<FormField[]>([]);
  const [promptContent, setPromptContent] = useState<any>(null);
  const [loading, setLoading] = useState(false);
  const [fetchingPrompts, setFetchingPrompts] = useState(false);
  const [promptsServedFromCache, setPromptsServedFromCache] = useState<
    ServedFromCache | undefined
  >(undefined);
  const [error, setError] = useState<string>("");
  const [isSidebarVisible, setIsSidebarVisible] = useState(true);
  const promptsFetchVersionRef = useRef(0);
  const promptGetVersionRef = useRef(0);
  const isServerConnected =
    serverConnectionStatus === undefined ||
    serverConnectionStatus === "connected";

  const selectedPromptData = useMemo(() => {
    return prompts.find((prompt) => prompt.name === selectedPrompt) ?? null;
  }, [prompts, selectedPrompt]);
  const promptDisplay = extractDisplayFromValue(promptContent);

  const resetLoadedPromptState = (
    invalidateRequests = true,
    stopLoading = true,
  ) => {
    if (invalidateRequests) {
      promptsFetchVersionRef.current += 1;
      promptGetVersionRef.current += 1;
    }
    if (stopLoading) {
      setLoading(false);
      setFetchingPrompts(false);
    }
    setPrompts([]);
    setSelectedPrompt("");
    setFormFields([]);
    setPromptContent(null);
    setError("");
    // SEP-2549 provenance describes the currently displayed prompt list; clear
    // it whenever that list is emptied so the badge cannot outlive its data.
    setPromptsServedFromCache(undefined);
  };

  useEffect(() => {
    if (!serverConfig || !serverName || !isServerConnected) {
      resetLoadedPromptState();
      return;
    }
    fetchPrompts();
  }, [serverConfig, serverName, isServerConnected]);

  useEffect(() => {
    if (selectedPromptData?.arguments) {
      generateFormFields(selectedPromptData.arguments);
    } else {
      setFormFields([]);
    }
  }, [selectedPromptData]);

  const fetchPrompts = async (forceRefresh = false) => {
    if (!serverName) return;
    if (!isServerConnected) {
      resetLoadedPromptState();
      return;
    }

    setFetchingPrompts(true);
    setError("");
    const fetchVersion = ++promptsFetchVersionRef.current;

    try {
      const serverPrompts = await listPromptsApi(serverName, {
        refresh: forceRefresh,
      });
      if (fetchVersion !== promptsFetchVersionRef.current) return;
      setPrompts(serverPrompts);
      setPromptsServedFromCache(serverPrompts.servedFromCache);

      // Clear selection if the selected prompt no longer exists
      if (
        selectedPrompt &&
        !serverPrompts.some((prompt) => prompt.name === selectedPrompt)
      ) {
        setSelectedPrompt("");
        setPromptContent(null);
      }
    } catch (err) {
      if (fetchVersion !== promptsFetchVersionRef.current) return;
      const message =
        err instanceof Error ? err.message : `Could not fetch prompts: ${err}`;
      setError(message);
    } finally {
      if (fetchVersion === promptsFetchVersionRef.current) {
        setFetchingPrompts(false);
      }
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
      if (!isServerConnected) {
        setError("Connect this server before running prompts.");
        return;
      }

      setLoading(true);
      setError("");
      const getVersion = ++promptGetVersionRef.current;

      try {
        const resolvedParams = params ?? buildParameters();
        const data = await getPromptApi(
          serverName,
          targetPrompt,
          resolvedParams,
        );
        if (getVersion !== promptGetVersionRef.current) return;
        setPromptContent(data.content);
      } catch (err) {
        if (getVersion !== promptGetVersionRef.current) return;
        const message =
          err instanceof Error ? err.message : `Error getting prompt: ${err}`;
        setError(message);
      } finally {
        if (getVersion === promptGetVersionRef.current) {
          setLoading(false);
        }
      }
    },
    [selectedPrompt, serverName, isServerConnected, buildParameters],
  );

  const promptNames = prompts.map((prompt) => prompt.name);

  // Handle Enter key in input fields
  const handleInputKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" && isServerConnected && !loading) {
      e.preventDefault();
      getPrompt();
    }
  };

  // Handle Enter key to get prompt globally
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (
        e.key === "Enter" &&
        !e.shiftKey &&
        selectedPrompt &&
        isServerConnected &&
        !loading
      ) {
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
  }, [selectedPrompt, isServerConnected, loading, getPrompt]);

  // Agent bridge: one mount-scoped tool (ui_get_prompt) plus a redacted
  // snapshot. Registered here — PromptsTab owns the prompt list and the
  // getPromptApi path the Run button uses. Must run before any early return
  // (rules of hooks); the handler throws when no server is selected.
  useSurfaceAgentBridge({
    surfaceId: "prompts",
    handlers: {
      getPrompt: async (command) => {
        if (!serverName) {
          throw createInspectorCommandClientError(
            "unsupported_in_mode",
            "No server is selected on the Prompts screen — select and connect one first.",
          );
        }
        if (!isServerConnected) {
          throw createInspectorCommandClientError(
            "unsupported_in_mode",
            "The selected server is not connected — connect it before rendering prompts.",
          );
        }
        const { payload } = command as GetPromptInspectorCommand;
        const key = payload?.prompt?.trim();
        if (!key) {
          throw createInspectorCommandClientError(
            "invalid_request",
            "'prompt' is required (a prompt name as shown on the screen).",
          );
        }
        const matches = prompts.filter(
          (p) => p.name === key || p.title === key,
        );
        if (matches.length === 0) {
          throw createInspectorCommandClientError(
            "invalid_request",
            `No prompt matches "${key}". Use a prompt name from this screen (list them with ui_snapshot_app).`,
          );
        }
        if (matches.length > 1) {
          throw createInspectorCommandClientError(
            "invalid_request",
            `"${key}" is ambiguous — pass the exact prompt name.`,
          );
        }
        const target = matches[0];
        const providedArgs = payload.arguments ?? {};
        // Reflect the selection on screen, like clicking the prompt does.
        setSelectedPrompt(target.name);
        setError("");
        setPromptContent(null);
        // Claim the render-version (same ref the on-screen Run path bumps) so a
        // slower render can't overwrite a newer selection's result.
        const getVersion = ++promptGetVersionRef.current;
        try {
          // SAME api the Run button uses (getPrompt → getPromptApi).
          const data = await getPromptApi(serverName, target.name, providedArgs);
          // Commit to the on-screen pane only if this is still the newest
          // render; the tool still returns what IT fetched.
          if (getVersion === promptGetVersionRef.current) {
            setPromptContent(data.content);
          }
          const capped = capPromptContentForTranscript(data.content);
          return {
            status: "prompt_rendered",
            prompt: target.name,
            ...capped,
            note: capped.truncated
              ? "Content was truncated for the transcript — view the full render on screen."
              : undefined,
          };
        } catch (e) {
          throw createInspectorCommandClientError(
            "execution_failed",
            e instanceof Error ? e.message : "Failed to render the prompt.",
          );
        }
      },
    },
    // Redacted STATE, not payloads: the selected server, the prompt NAMES
    // (bounded), the current selection + its argument FIELD NAMES (never the
    // values), and whether a render exists (presence/size only, never content).
    snapshot: () => {
      // Bounded: never fully serialize a huge prompt body just to size it.
      const { bytes: lastResultBytes, truncated: lastResultTruncated } =
        promptContent !== null && promptContent !== undefined
          ? boundedJsonByteLength(promptContent)
          : { bytes: 0, truncated: false };
      return {
        selectedServer: serverName ?? null,
        connected: isServerConnected,
        promptCount: prompts.length,
        prompts: prompts
          .slice(0, PROMPT_SNAPSHOT_MAX_ITEMS)
          .map((p) => ({ name: p.name, title: p.title ?? null })),
        selectedPrompt: selectedPrompt || null,
        selectedPromptArgumentNames: formFields.map((f) => f.name),
        lastResult: {
          present: promptContent !== null && promptContent !== undefined,
          approxSizeBytes: lastResultBytes,
          ...(lastResultTruncated ? { approxSizeCapped: true } : {}),
        },
      };
    },
  });

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

          <CacheProvenanceBadge servedFromCache={promptsServedFromCache} />

          {/* Secondary actions */}
          <div className="flex items-center gap-0.5 text-muted-foreground/80">
            <Button
              onClick={() => fetchPrompts(true)}
              variant="ghost"
              size="sm"
              disabled={fetchingPrompts || !isServerConnected}
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
            disabled={loading || !selectedPrompt || !isServerConnected}
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
            toolSwitchList={{
              names: prompts.map((p) => p.name),
              onSelect: (name) => {
                setSelectedPrompt(name);
                setError("");
                setPromptContent(null);

                const prompt = prompts.find((p) => p.name === name);
                if (!prompt?.arguments || prompt.arguments.length === 0) {
                  void getPrompt(name, {});
                }
              },
            }}
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
                    {isServerConnected
                      ? "No prompts available"
                      : "Connect this server to load prompts."}
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
        ) : promptContent !== null && promptContent !== undefined ? (
          <div className="flex-1 min-h-0 p-4 flex flex-col">
            {promptDisplay?.kind === "text" ? (
              <pre className="flex-1 min-h-0 whitespace-pre-wrap text-xs font-mono bg-muted/30 p-4 rounded-md border border-border overflow-auto">
                {promptDisplay.text}
              </pre>
            ) : (
              <div className="flex-1 min-h-0">
                <JsonEditor
                  value={
                    promptDisplay?.kind === "json"
                      ? promptDisplay.value
                      : promptContent
                  }
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
