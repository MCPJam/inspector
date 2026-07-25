import { useEffect, useMemo, useRef, useState } from "react";
import type {
  CallToolResult,
  ElicitRequest,
  ElicitResult,
  Tool,
} from "@modelcontextprotocol/client";
import { Wrench } from "lucide-react";
import { ElicitationDialog } from "./ElicitationDialog";
import { MrtrElicitationHost } from "./elicitation/MrtrElicitationHost";
import { EmptyState } from "./ui/empty-state";
import { navigateApp } from "@/lib/app-navigation";
import { ThreePanelLayout } from "./ui/three-panel-layout";
import { ResultsPanel } from "./tools/ResultsPanel";
import { ToolsSidebar } from "./tools/ToolsSidebar";
import SaveRequestDialog from "./tools/SaveRequestDialog";
import {
  applyParametersToFields as applyParamsToFields,
  buildParametersFromFields,
  generateFormFieldsFromSchema,
  type FormField as ToolFormField,
} from "@/lib/tool-form";
import {
  deleteRequest,
  duplicateRequest,
  listSavedRequests,
  saveRequest,
  updateRequestMeta,
} from "@/lib/request-storage";
import type { SavedRequest } from "@/lib/types/request-types";
import { useLogger } from "@/hooks/use-logger";
import {
  executeToolApi,
  listTools,
  respondToElicitationApi,
  type ToolExecutionResponse,
  type TaskOptions,
  type ServedFromCache,
} from "@/lib/apis/mcp-tools-api";
import {
  getTaskCapabilities,
  type TaskCapabilities,
} from "@/lib/apis/mcp-tasks-api";
import { trackTask } from "@/lib/task-tracker";
import { validateToolOutput } from "@/lib/schema-utils";
import {
  applyToolCallStepUp,
  resetToolCallStepUp,
} from "@/state/oauth-orchestrator";
import type { ServerWithName } from "@/state/app-types";
import type { MCPServerConfig } from "@mcpjam/sdk/browser";
import { isNormalizedError } from "@mcpjam/sdk/browser";
import { WebApiError } from "@/lib/apis/web/base";
import { track } from "@/lib/analytics";
import { useQuery } from "convex/react";
import { stripConvexReservedKeys } from "@/lib/convex-args";
import { useToolQualityEnabled } from "@/hooks/useToolQualityEnabled";
import type { ConnectionStatus } from "@/state/app-types";
import type { ToolQualityInfo } from "./tools/ToolItem";
import type { McpToolResultImageRenderingPolicy } from "@/lib/client-config-v2";
import { boundedJsonByteLength } from "@/lib/webmcp/bounded-size";
import { useSurfaceAgentBridge } from "@/lib/webmcp/use-surface-agent-bridge";

type ToolMap = Record<string, Tool>;
type FormField = ToolFormField;

/** Cap the list of tools the snapshot enumerates (names only). */
const TOOLS_SNAPSHOT_MAX_ITEMS = 30;

// Shape returned by the backend tool-quality lint query (string-named). The
// inspector renders these purely as neutral per-tool quality badges.
interface ToolQualityCodeView {
  code: string;
  label: string;
  class: string;
  detail?: Record<string, number>;
}
interface ToolQualityView {
  serverId: string;
  toolName: string;
  severity: "error" | "warn";
  codes: ToolQualityCodeView[];
}
type ToolQualityQueryResult = ToolQualityView[] | { tooLarge: true };

function formatQualityLabel(code: ToolQualityCodeView): string {
  if (!code.detail) return code.label;
  const parts = Object.entries(code.detail).map(([k, v]) => `${k}=${v}`);
  return parts.length ? `${code.label} (${parts.join(", ")})` : code.label;
}

type ActiveElicitation = {
  executionId: string;
  requestId: string;
  request: ElicitRequest["params"];
  timestamp: string;
};

export type DialogElicitation = {
  requestId: string;
  message: string;
  schema?: Record<string, unknown>;
  timestamp: string;
  /**
   * The era this input request came from, so the dialog can label it honestly:
   *
   * - `legacy-request` — an unsolicited server→client `elicitation/create`
   *   request (the client is answering a question the server asked mid-call).
   * - `mrtr` — a modern (2026-07-28) multi-round-trip `input_required` result:
   *   the OPERATION itself needs input before it can complete, and the client
   *   collects it and retries the original call.
   *
   * Optional/additive: surfaces that predate the distinction omit it and get
   * the neutral legacy phrasing.
   */
  origin?: "legacy-request" | "mrtr";
  /**
   * Identity of the server requesting information (MCP spec MUST: the client
   * must make it clear which server is asking). Optional and additive: local
   * surfaces that don't yet plumb it through fall back to a generic header.
   *
   * `serverId` is the immutable, locally-assigned identifier — the trusted
   * anchor. `serverName` is a server-supplied display label and is NOT trusted.
   */
  serverId?: string;
  serverName?: string;
};

function normalizeElicitationContent(
  parameters?: Record<string, unknown>
): ElicitResult["content"] | undefined {
  if (!parameters) return undefined;
  const content: ElicitResult["content"] = {};
  for (const [key, value] of Object.entries(parameters)) {
    if (
      typeof value === "string" ||
      typeof value === "number" ||
      typeof value === "boolean"
    ) {
      content[key] = value;
    } else if (
      Array.isArray(value) &&
      value.every((v): v is string => typeof v === "string")
    ) {
      content[key] = value;
    } else if (value !== undefined) {
      content[key] = JSON.stringify(value);
    }
  }
  return content;
}

interface ToolsTabProps {
  serverConfig?: MCPServerConfig;
  serverName?: string;
  /**
   * The full server entry — needed to drive a SEP-2350 runtime scope step-up
   * when a tool call returns a `403 insufficient_scope` challenge (issuer +
   * originally-requested scopes are resolved from it). Optional: surfaces that
   * don't plumb it through simply never trigger the local step-up.
   */
  server?: ServerWithName;
  serverConnectionStatus?: ConnectionStatus;
  mcpToolResultImageRendering?: McpToolResultImageRenderingPolicy;
}

export function ToolsTab({
  serverConfig,
  serverName,
  server,
  serverConnectionStatus,
  mcpToolResultImageRendering,
}: ToolsTabProps) {
  const logger = useLogger("ToolsTab");
  const [tools, setTools] = useState<ToolMap>({});
  const [selectedTool, setSelectedTool] = useState<string>("");
  const [formFields, setFormFields] = useState<FormField[]>([]);
  const [result, setResult] = useState<CallToolResult | null>(null);
  const [structuredContentValid, setStructuredContentValid] = useState<
    boolean | undefined
  >(undefined);
  const [loadingExecuteTool, setLoadingExecuteTool] = useState(false);
  const [fetchingTools, setFetchingTools] = useState(false);
  const [error, setError] = useState<string>("");
  const [normalizedError, setNormalizedError] = useState<
    import("@mcpjam/sdk/browser").NormalizedError | null
  >(null);
  const [responseDurationMs, setResponseDurationMs] = useState<number | null>(
    null
  );
  const [activeElicitation, setActiveElicitation] =
    useState<ActiveElicitation | null>(null);
  const [elicitationLoading, setElicitationLoading] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [activeTab, setActiveTab] = useState<"tools" | "saved">("tools");
  const [highlightedRequestId, setHighlightedRequestId] = useState<
    string | null
  >(null);
  const [lastToolName, setLastToolName] = useState<string | null>(null);
  const [savedRequests, setSavedRequests] = useState<SavedRequest[]>([]);
  const [isSaveDialogOpen, setIsSaveDialogOpen] = useState(false);
  const [editingRequestId, setEditingRequestId] = useState<string | null>(null);
  const [dialogDefaults, setDialogDefaults] = useState<{
    title: string;
    description?: string;
  }>({ title: "" });
  const [executeAsTask, setExecuteAsTask] = useState(false);
  const [isSidebarVisible, setIsSidebarVisible] = useState(true);
  // Task capabilities from server (MCP Tasks spec 2025-11-25)
  const [taskCapabilities, setTaskCapabilities] =
    useState<TaskCapabilities | null>(null);
  // TTL for task execution (milliseconds, 0 = no expiration)
  const [taskTtl, setTaskTtl] = useState<number>(0);
  // Infinite scroll state
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  const toolFetchVersionRef = useRef(0);
  const taskCapabilitiesFetchVersionRef = useRef(0);
  // SEP-2350: guards against a second tool run (or a repeated error) kicking off
  // a duplicate step-up while the first is still in flight — a double redirect
  // or double counter bump. Keyed by server name so distinct servers never
  // block each other.
  const stepUpInFlightRef = useRef<Set<string>>(new Set());
  const [cursor, setCursor] = useState<string | undefined>(undefined);
  const [servedFromCache, setServedFromCache] = useState<
    ServedFromCache | undefined
  >(undefined);
  const isServerConnected =
    serverConnectionStatus === undefined ||
    serverConnectionStatus === "connected";
  const serverKey = useMemo(() => {
    if (!serverConfig) return "none";
    try {
      if ((serverConfig as any).url) {
        return `http:${(serverConfig as any).url}`;
      }
      if ((serverConfig as any).command) {
        const args = ((serverConfig as any).args || []).join(" ");
        return `stdio:${(serverConfig as any).command} ${args}`.trim();
      }
      return JSON.stringify(serverConfig);
    } catch {
      return "unknown";
    }
  }, [serverConfig]);

  // Check if the selected tool requires task execution
  // Per MCP Tasks spec: execution.taskSupport can be "required", "optional", or "forbidden"
  const selectedToolTaskSupport = useMemo(():
    | "required"
    | "optional"
    | "forbidden" => {
    if (!selectedTool || !tools[selectedTool]) return "forbidden";
    const tool = tools[selectedTool];
    const execution = (tool as any).execution;

    // Check standard spec format: execution.taskSupport
    const taskSupport = execution?.taskSupport;
    if (taskSupport === "required" || taskSupport === "optional") {
      return taskSupport;
    }
    if (taskSupport === "forbidden") {
      return "forbidden";
    }

    const taskMode = execution?.task;
    if (taskMode === "always" || taskMode === "required") return "required";
    if (taskMode === "optional") return "optional";
    if (taskMode === "never" || taskMode === "forbidden") return "forbidden";

    // Per MCP spec: if execution.taskSupport is not present, treat as "forbidden"
    // Clients MUST NOT attempt to invoke the tool as a task
    return "forbidden";
  }, [selectedTool, tools]);

  // Check if server supports task-augmented tool calls (MCP Tasks spec 2025-11-25)
  // Per spec: clients MUST NOT use task augmentation if server doesn't declare capability
  const serverSupportsTaskToolCalls =
    taskCapabilities?.supportsToolCalls ?? false;

  const resetLoadedToolState = ({
    invalidateRequests = true,
    stopLoading = true,
    clearTaskCapabilities = true,
  }: {
    invalidateRequests?: boolean;
    stopLoading?: boolean;
    clearTaskCapabilities?: boolean;
  } = {}) => {
    if (invalidateRequests) {
      toolFetchVersionRef.current += 1;
      taskCapabilitiesFetchVersionRef.current += 1;
    }
    if (stopLoading) {
      setFetchingTools(false);
      setLoadingExecuteTool(false);
      setElicitationLoading(false);
    }
    setTools({});
    setSelectedTool("");
    setFormFields([]);
    setResult(null);
    setStructuredContentValid(undefined);
    setError("");
    setNormalizedError(null);
    setResponseDurationMs(null);
    setActiveElicitation(null);
    if (clearTaskCapabilities) {
      setTaskCapabilities(null);
    }
    setCursor(undefined);
    // SEP-2549 provenance describes the currently displayed list; once that
    // list is cleared (disconnect, server switch, or a reset before a
    // refresh) the badge must not survive to describe stale/other-server data.
    setServedFromCache(undefined);
  };

  useEffect(() => {
    if (!serverConfig || !serverName || !isServerConnected) {
      resetLoadedToolState();
      return;
    }
    void fetchTools(true);
    void fetchTaskCapabilities();
  }, [serverConfig, serverName, isServerConnected]);

  // Rollout gate (PostHog): only lint when the flag is on. Off ⇒ the snapshot
  // stays null ⇒ the query below is skipped and no badges render.
  const toolQualityEnabled = useToolQualityEnabled();

  // Live per-tool quality lint for the loaded tools. Pure backend compute over
  // a snapshot of the current tool definitions; the sidebar renders a small
  // badge per flagged tool. The snapshot carries no version (the backend owns
  // it) and no timestamp, and the tools are sorted by name — keeping the query
  // args a canonical function of the tool set (independent of load order) lets
  // the subscription dedupe across renders and incremental refetches instead of
  // churning. Convex-reserved keys ($-/_-prefixed: JSON Schema's $ref/$defs/
  // $schema, MCP _meta) are stripped so the client can serialize the args at all.
  const toolQualitySnapshot = useMemo(() => {
    if (!toolQualityEnabled || !serverName) return null;
    const toolList = Object.values(tools)
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((tool) => stripConvexReservedKeys(tool));
    if (toolList.length === 0) return null;
    return { servers: [{ serverId: serverName, tools: toolList }] };
  }, [tools, serverName, toolQualityEnabled]);

  const toolQualityResult = useQuery(
    "toolPrechecks:get" as any,
    toolQualitySnapshot ? ({ snapshot: toolQualitySnapshot } as any) : "skip"
  ) as ToolQualityQueryResult | undefined;

  const toolQualityByName = useMemo(() => {
    const map = new Map<string, ToolQualityInfo>();
    if (Array.isArray(toolQualityResult)) {
      for (const view of toolQualityResult) {
        map.set(view.toolName, {
          severity: view.severity,
          labels: view.codes.map(formatQualityLabel),
        });
      }
    }
    return map;
  }, [toolQualityResult]);

  const toolNames = Object.keys(tools);
  const filteredToolNames = searchQuery.trim()
    ? toolNames.filter((name) => {
        const tool = tools[name];
        const haystack = `${name} ${tool?.description ?? ""}`.toLowerCase();
        return haystack.includes(searchQuery.trim().toLowerCase());
      })
    : toolNames;

  // IntersectionObserver for infinite scroll
  useEffect(() => {
    if (!sentinelRef.current) return;
    if (activeTab !== "tools") return; // Only observe when tools tab is active

    const element = sentinelRef.current;
    const observer = new IntersectionObserver((entries) => {
      const entry = entries[0];
      if (!entry.isIntersecting) return;
      if (!cursor || fetchingTools) return;

      // Load more tools
      fetchTools();
    });

    observer.observe(element);

    return () => {
      observer.unobserve(element);
      observer.disconnect();
    };
  }, [filteredToolNames.length, activeTab, cursor, fetchingTools]);

  // Fetch task capabilities for the server
  const fetchTaskCapabilities = async () => {
    if (!serverName) return;
    if (!isServerConnected) return;
    const fetchVersion = ++taskCapabilitiesFetchVersionRef.current;
    try {
      const capabilities = await getTaskCapabilities(serverName);
      if (fetchVersion !== taskCapabilitiesFetchVersionRef.current) return;
      setTaskCapabilities(capabilities);
      logger.info("Task capabilities fetched", {
        serverId: serverName,
        supportsToolCalls: capabilities.supportsToolCalls,
        supportsList: capabilities.supportsList,
        supportsCancel: capabilities.supportsCancel,
      });
    } catch (err) {
      if (fetchVersion !== taskCapabilitiesFetchVersionRef.current) return;
      // Server may not support tasks - this is fine, just log it
      logger.debug("Could not fetch task capabilities", {
        error: err instanceof Error ? err.message : "Unknown error",
      });
      setTaskCapabilities(null);
    }
  };

  useEffect(() => {
    if (!serverConfig) return;
    setSavedRequests(listSavedRequests(serverKey));
  }, [serverConfig, serverKey]);

  useEffect(() => {
    if (selectedTool && tools[selectedTool]) {
      setFormFields(
        generateFormFieldsFromSchema(tools[selectedTool].inputSchema)
      );
    }
  }, [selectedTool, tools]);

  useEffect(() => {
    track("tools_tab_viewed", {
      location: "tools_tab",
    });
  }, []);

  // Clicking the sidebar's "Tools" tab returns to the tool list (the tool
  // menu): deselect any open tool, the same as the back arrow does.
  const handleChangeTab = (tab: "tools" | "saved") => {
    setActiveTab(tab);
    if (tab === "tools") {
      setSelectedTool("");
    }
  };

  const fetchTools = async (reset = false, forceRefresh = false) => {
    if (!serverName) {
      logger.warn("Cannot fetch tools: no serverId available");
      return;
    }
    if (!isServerConnected) {
      resetLoadedToolState();
      return;
    }

    setError("");
    setNormalizedError(null);
    setFetchingTools(true);
    if (reset) {
      resetLoadedToolState({
        invalidateRequests: false,
        stopLoading: false,
        clearTaskCapabilities: false,
      });
    }
    const fetchVersion = ++toolFetchVersionRef.current;

    try {
      // Call to get all of the tools for server
      const data = await listTools({
        serverId: serverName,
        cursor: reset ? undefined : cursor,
        refresh: forceRefresh,
      });
      if (fetchVersion !== toolFetchVersionRef.current) return;
      const toolArray = data.tools ?? [];
      const dictionary = Object.fromEntries(
        toolArray.map((tool: Tool) => [tool.name, tool])
      );
      setTools((prev) => (reset ? dictionary : { ...prev, ...dictionary }));
      setCursor(data.nextCursor);
      // SEP-2549 provenance: only ever set on an actual hit — a non-hit
      // fetch clears any stale badge from a previous cached response.
      setServedFromCache(data.servedFromCache);
      logger.info("Tools fetched", {
        serverId: serverName,
        toolCount: toolArray.length,
      });
    } catch (err) {
      if (fetchVersion !== toolFetchVersionRef.current) return;
      const message = err instanceof Error ? err.message : "Unknown error";
      logger.error("Failed to fetch tools", { error: message });
      setError(message);
      // Preserve the backend-attached `normalized` block when listTools
      // threw a WebApiError, but shape-validate first. Partial payloads
      // would otherwise shadow the real `error` string at render
      // (ResultsPanel prefers normalizedError over error).
      setNormalizedError(
        err instanceof WebApiError && isNormalizedError(err.normalized)
          ? err.normalized
          : null
      );
    } finally {
      if (fetchVersion === toolFetchVersionRef.current) {
        setFetchingTools(false);
      }
    }
  };

  const updateFieldValue = (fieldName: string, value: unknown) => {
    setFormFields((prev) =>
      prev.map((field) =>
        field.name === fieldName ? { ...field, value } : field
      )
    );
  };

  const updateFieldIsSet = (fieldName: string, isSet: boolean) => {
    setFormFields((prev) =>
      prev.map((field) =>
        field.name === fieldName ? { ...field, isSet } : field
      )
    );
  };

  const applyParametersToFields = (params: Record<string, unknown>) => {
    setFormFields((prev) => applyParamsToFields(prev, params));
  };

  const buildParameters = (): Record<string, unknown> =>
    buildParametersFromFields(formFields, (msg, ctx) => logger.warn(msg, ctx));

  const getToolMeta = (
    toolName: string | null
  ): Record<string, any> | undefined => {
    return toolName ? tools[toolName]?._meta : undefined;
  };

  // SEP-2350: a successful call clears the bounded step-up counter so a future
  // legitimate scope step-up starts fresh rather than inheriting a stale count
  // that would prematurely throw. Factored so BOTH success paths — an immediate
  // `completed` result and a task-augmented `task_created` — reset it.
  const resetStepUpOnSuccess = () => {
    if (!server) return;
    try {
      resetToolCallStepUp(server);
    } catch (err) {
      logger.warn("Failed to reset step-up counter", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  };

  const handleExecutionResponse = (
    response: ToolExecutionResponse,
    toolName: string
  ) => {
    const durationMs =
      "durationMs" in response && typeof response.durationMs === "number"
        ? response.durationMs
        : null;

    if ("result" in response && response.status === "completed") {
      setActiveElicitation(null);
      setResponseDurationMs(durationMs);
      const callResult = response.result;
      setResult(callResult);

      resetStepUpOnSuccess();

      const rawResult = callResult as unknown as Record<string, unknown>;
      const currentTool = tools[toolName];
      setStructuredContentValid(
        validateToolOutput(rawResult, currentTool?.outputSchema)
      );

      logger.info("Tool execution completed", {
        toolName,
        duration: durationMs ?? undefined,
      });
      return;
    }

    if ("status" in response && response.status === "elicitation_required") {
      setResponseDurationMs(durationMs);
      setActiveElicitation({
        executionId: response.executionId,
        requestId: response.requestId,
        request: response.request,
        timestamp: response.timestamp,
      });
      return;
    }

    // Handle task creation response (MCP Tasks spec 2025-11-25)
    if ("status" in response && response.status === "task_created") {
      const { task, modelImmediateResponse } = response;

      // A task-augmented tool that succeeds lands here, not in the `completed`
      // branch — reset the step-up counter on this success path too so a stale
      // count doesn't prematurely throw a later legitimate step-up.
      resetStepUpOnSuccess();

      // Track the task locally so it appears in the Tasks tab
      if (serverName) {
        trackTask({
          taskId: task.taskId,
          serverId: serverName,
          createdAt: task.createdAt,
          toolName,
          primitiveType: "tool",
          primitiveName: toolName,
        });
      }

      logger.info("Background task created", {
        toolName,
        taskId: task.taskId,
        status: task.status,
        ttl: task.ttl,
        pollInterval: task.pollInterval,
        duration: durationMs ?? undefined,
        // Per MCP Tasks spec: optional string for LLM hosts to return to model immediately
        modelImmediateResponse: modelImmediateResponse || undefined,
      });

      // Navigate to Tasks tab to monitor the task
      navigateApp("/tasks");
      return;
    }

    if ("error" in response && response.error) {
      setResponseDurationMs(durationMs);
      setError(response.error as string);
      // Preserve the rich describer block when the response carried one
      // (server-side `jsonError` always populates `normalized`), but
      // shape-validate first — a partial `{}` would otherwise shadow the
      // real `error` string at render. ResultsPanel prefers
      // normalizedError over error, so an invalid block hides the API's
      // actual message and yields a generic "Unknown error" ErrorCard.
      const maybeNormalized = (response as { normalized?: unknown }).normalized;
      setNormalizedError(
        isNormalizedError(maybeNormalized) ? maybeNormalized : null
      );

      // SEP-2350 runtime scope step-up: the tool call failed with a
      // `403 insufficient_scope`. Drive the bounded, union-scope
      // re-authorization for the local (non-hosted) surface. On `reauthorize`
      // this redirects the browser to the authorization server; `throw` /
      // `manual` leave the surfaced error in place.
      const insufficientScope = (
        response as { insufficientScope?: import("@/lib/apis/mcp-tools-api").ToolInsufficientScopeChallenge }
      ).insufficientScope;
      if (insufficientScope && server) {
        // Dedup: only one step-up may be in flight per server. Without this a
        // second tool run (or a repeated error) while the first is still
        // resolving could fire a duplicate — a double redirect or double
        // counter bump. The guard clears once the step-up settles.
        const stepUpKey = server.name;
        if (!stepUpInFlightRef.current.has(stepUpKey)) {
          stepUpInFlightRef.current.add(stepUpKey);
          void applyToolCallStepUp(server, {
            requiredScope: insufficientScope.requiredScope,
            resourceMetadataUrl: insufficientScope.resourceMetadataUrl,
          })
            .catch((err) => {
              logger.error("Step-up re-authorization failed", {
                toolName,
                error: err instanceof Error ? err.message : String(err),
              });
            })
            .finally(() => {
              stepUpInFlightRef.current.delete(stepUpKey);
            });
        }
      }
    }
  };

  const executeTool = async () => {
    if (!selectedTool) {
      logger.warn("Cannot execute tool: no tool selected");
      return;
    }
    if (!serverName) {
      logger.warn("Cannot execute tool: no serverId available");
      return;
    }
    if (!isServerConnected) {
      logger.warn("Cannot execute tool: server is not connected", {
        serverId: serverName,
        connectionStatus: serverConnectionStatus,
      });
      setError("Connect this server before running tools.");
      setNormalizedError(null);
      return;
    }

    setLoadingExecuteTool(true);
    setError("");
    setNormalizedError(null);
    setResult(null);
    setStructuredContentValid(undefined);
    setResponseDurationMs(null);

    try {
      const params = buildParameters();
      setLastToolName(selectedTool);

      // Pass task options if executing as background task (MCP Tasks spec 2025-11-25)
      // Use task execution only if: server supports tasks AND (user checked option OR tool requires it)
      // Per spec: clients MUST NOT use task augmentation without server capability
      const shouldUseTask =
        serverSupportsTaskToolCalls &&
        (executeAsTask || selectedToolTaskSupport === "required");
      // Per MCP spec: ttl is optional. Only include if user specified a non-zero value.
      // 0 could be misinterpreted by servers, so we use undefined to let server decide.
      const taskOptions: TaskOptions | undefined = shouldUseTask
        ? { ttl: taskTtl > 0 ? taskTtl : undefined }
        : undefined;

      const response = await executeToolApi(
        serverName,
        selectedTool,
        params,
        taskOptions
      );
      handleExecutionResponse(response, selectedTool);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      logger.error("Tool execution network error", {
        toolName: selectedTool,
        error: message,
      });
      setError(message);
    } finally {
      setLoadingExecuteTool(false);
    }
  };

  // Handle Enter key to execute tool globally
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Check if Enter is pressed (not Shift+Enter)
      if (
        e.key === "Enter" &&
        !e.shiftKey &&
        selectedTool &&
        isServerConnected &&
        !loadingExecuteTool
      ) {
        // Don't trigger if user is typing in an input, textarea, or contenteditable
        const target = e.target as HTMLElement;
        const tagName = target.tagName;
        const isEditable = target.isContentEditable;

        if (tagName === "INPUT" || tagName === "TEXTAREA" || isEditable) {
          return;
        }

        e.preventDefault();
        executeTool();
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [selectedTool, isServerConnected, loadingExecuteTool]);

  const handleElicitationResponse = async (
    action: "accept" | "decline" | "cancel",
    parameters?: Record<string, unknown>
  ) => {
    if (!activeElicitation) {
      logger.warn("Cannot handle elicitation response: no active request");
      return;
    }

    setElicitationLoading(true);
    try {
      const content = normalizeElicitationContent(parameters);
      const payload: ElicitResult =
        action === "accept" && content
          ? { action: "accept", content }
          : { action };
      const response = await respondToElicitationApi(
        activeElicitation.executionId,
        activeElicitation.requestId,
        payload
      );
      handleExecutionResponse(response, selectedTool);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      logger.error("Error responding to elicitation", {
        requestId: activeElicitation.requestId,
        action,
        error: message,
      });
      setError(message);
    } finally {
      setElicitationLoading(false);
    }
  };

  const handleSaveCurrent = () => {
    if (!selectedTool) return;
    setEditingRequestId(null);
    setDialogDefaults({ title: selectedTool, description: "" });
    setIsSaveDialogOpen(true);
  };

  const handleLoadRequest = (req: SavedRequest) => {
    setSelectedTool(req.toolName);
    setTimeout(() => applyParametersToFields(req.parameters), 50);
  };

  const handleDeleteRequest = (id: string) => {
    deleteRequest(serverKey, id);
    setSavedRequests(listSavedRequests(serverKey));
  };

  const handleDuplicateRequest = (req: SavedRequest) => {
    const duplicated = duplicateRequest(serverKey, req.id);
    setSavedRequests(listSavedRequests(serverKey));
    if (duplicated?.id) {
      setHighlightedRequestId(duplicated.id);
      setTimeout(() => setHighlightedRequestId(null), 2000);
    }
  };

  const handleRenameRequest = (req: SavedRequest) => {
    setEditingRequestId(req.id);
    setDialogDefaults({ title: req.title, description: req.description });
    setIsSaveDialogOpen(true);
  };

  const handleToolRefresh = () => {
    // Explicit user "Refresh" click ⇒ cacheMode: "refresh" server-side, so it
    // always re-fetches even if a still-fresh cached entry exists.
    void fetchTools(true, true);
  };

  const filteredSavedRequests = searchQuery.trim()
    ? savedRequests.filter((tool) => {
        const haystack = `${tool.title} ${
          tool.description ?? ""
        }`.toLowerCase();
        return haystack.includes(searchQuery.trim().toLowerCase());
      })
    : savedRequests;

  const dialogElicitation: DialogElicitation | null = activeElicitation
    ? {
        requestId: activeElicitation.requestId,
        message: activeElicitation.request.message,
        schema: (activeElicitation.request as any).requestedSchema as
          | Record<string, unknown>
          | undefined,
        timestamp: activeElicitation.timestamp,
        // This surface's `/execute` bridge answers a legacy server→client
        // `elicitation/create`; modern `input_required` input is collected by
        // `MrtrElicitationHost` below (era-labeled `mrtr`).
        origin: "legacy-request",
      }
    : null;

  // Agent bridge: SNAPSHOT-ONLY. Tool EXECUTION is already covered by the
  // global ui_execute_tool, so this surface adds no tool of its own — a
  // ui_run_server_tool would just duplicate it (the plan drops it). It registers
  // only a redacted snapshot so the agent can OBSERVE this screen. Must run
  // before any early return (rules of hooks). Redacted STATE, not payloads: the
  // selected server, the tool NAMES (bounded), the current selection + its
  // parameter FIELD NAMES (never the values), and whether a result exists
  // (presence/size only, never the content).
  useSurfaceAgentBridge({
    surfaceId: "tools",
    snapshot: () => {
      // Bounded: never fully serialize a huge tool result just to size it.
      const { bytes: lastResultBytes, truncated: lastResultTruncated } = result
        ? boundedJsonByteLength(result)
        : { bytes: 0, truncated: false };
      const names = Object.keys(tools);
      return {
        selectedServer: serverName ?? null,
        connected: isServerConnected,
        activeTab,
        toolCount: names.length,
        tools: names.slice(0, TOOLS_SNAPSHOT_MAX_ITEMS),
        selectedTool: selectedTool || null,
        selectedToolParameterNames: formFields.map((f) => f.name),
        savedRequestCount: savedRequests.length,
        lastToolName: lastToolName ?? null,
        lastResult: {
          present: Boolean(result),
          approxSizeBytes: lastResultBytes,
          ...(lastResultTruncated ? { approxSizeCapped: true } : {}),
        },
      };
    },
  });

  if (!serverConfig) {
    return (
      <EmptyState
        icon={Wrench}
        title="No Server Selected"
        description="Connect to an MCP server to explore and test its available tools."
      />
    );
  }

  const sidebarContent = (
    <ToolsSidebar
      activeTab={activeTab}
      onChangeTab={handleChangeTab}
      tools={tools}
      toolQuality={toolQualityByName}
      toolNames={toolNames}
      filteredToolNames={filteredToolNames}
      selectedToolName={selectedTool}
      fetchingTools={fetchingTools}
      searchQuery={searchQuery}
      onSearchQueryChange={setSearchQuery}
      onRefresh={handleToolRefresh}
      servedFromCache={servedFromCache}
      onSelectTool={setSelectedTool}
      savedRequests={filteredSavedRequests}
      highlightedRequestId={highlightedRequestId}
      onLoadRequest={handleLoadRequest}
      onRenameRequest={handleRenameRequest}
      onDuplicateRequest={handleDuplicateRequest}
      onDeleteRequest={handleDeleteRequest}
      displayedToolCount={toolNames.length}
      sentinelRef={sentinelRef}
      loadingMore={fetchingTools}
      cursor={cursor ?? ""}
      serverConnected={isServerConnected}
      formFields={formFields}
      onFieldChange={updateFieldValue}
      onToggleField={updateFieldIsSet}
      loading={loadingExecuteTool}
      waitingOnElicitation={!!activeElicitation}
      onExecute={executeTool}
      onSave={handleSaveCurrent}
      executeAsTask={
        serverSupportsTaskToolCalls && selectedToolTaskSupport !== "forbidden"
          ? executeAsTask
          : undefined
      }
      onExecuteAsTaskChange={
        serverSupportsTaskToolCalls && selectedToolTaskSupport !== "forbidden"
          ? setExecuteAsTask
          : undefined
      }
      taskRequired={
        serverSupportsTaskToolCalls && selectedToolTaskSupport === "required"
      }
      taskTtl={taskTtl}
      onTaskTtlChange={setTaskTtl}
      serverSupportsTaskToolCalls={serverSupportsTaskToolCalls}
      onClose={() => setIsSidebarVisible(false)}
    />
  );

  const centerContent = selectedTool ? (
    <ResultsPanel
      error={error}
      normalizedError={normalizedError}
      result={result}
      structuredContentValid={structuredContentValid}
      toolMeta={getToolMeta(lastToolName)}
      responseDurationMs={responseDurationMs}
      serverName={serverName}
      mcpToolResultImageRendering={mcpToolResultImageRendering}
    />
  ) : (
    <div className="h-full flex items-center justify-center">
      <div className="text-center">
        <div className="w-12 h-12 bg-muted rounded-full flex items-center justify-center mx-auto mb-3">
          <Wrench className="h-5 w-5 text-muted-foreground" />
        </div>
        <p className="text-xs font-semibold text-foreground mb-1">
          No selection
        </p>
        <p className="text-xs text-muted-foreground font-medium">
          Choose a tool from the left to configure parameters
        </p>
      </div>
    </div>
  );

  return (
    <>
      <ThreePanelLayout
        id="tools"
        sidebar={sidebarContent}
        content={centerContent}
        sidebarVisible={isSidebarVisible}
        onSidebarVisibilityChange={setIsSidebarVisible}
        sidebarTooltip="Show tools sidebar"
        serverName={serverName}
      />

      <ElicitationDialog
        elicitationRequest={dialogElicitation}
        onResponse={handleElicitationResponse}
        loading={elicitationLoading}
      />

      {/* Modern MRTR (`input_required`) input rail. When the running tool
          returns an `input_required` result, the SDK driver collects rounds
          through this shared dialog and retries the original call. */}
      <MrtrElicitationHost />

      <SaveRequestDialog
        open={isSaveDialogOpen}
        defaultTitle={dialogDefaults.title}
        defaultDescription={dialogDefaults.description}
        onCancel={() => setIsSaveDialogOpen(false)}
        onSave={({ title, description }) => {
          if (editingRequestId) {
            updateRequestMeta(serverKey, editingRequestId, {
              title,
              description,
            });
            setSavedRequests(listSavedRequests(serverKey));
            setEditingRequestId(null);
            setIsSaveDialogOpen(false);
            setActiveTab("saved");
            setHighlightedRequestId(editingRequestId);
            setTimeout(() => setHighlightedRequestId(null), 2000);
            return;
          }

          const params = buildParameters();
          const newRequest = saveRequest(serverKey, {
            title,
            description,
            toolName: selectedTool,
            parameters: params,
          });
          setSavedRequests(listSavedRequests(serverKey));
          setIsSaveDialogOpen(false);
          setActiveTab("saved");
          if (newRequest?.id) {
            setHighlightedRequestId(newRequest.id);
            setTimeout(() => setHighlightedRequestId(null), 2000);
          }
        }}
      />
    </>
  );
}
