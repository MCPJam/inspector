import { useState, useCallback } from "react";
import { toast } from "sonner";
import {
  useViewMutations,
  useProjectServers,
  useServerMutations,
  type DisplayContext,
  type WidgetCsp,
  type ServerInfo,
} from "./useViews";
import { UIType } from "@/lib/mcp-ui/mcp-apps-utils";
import { useCurrentDisplayContext } from "@/lib/display-context-utils";

// Data extracted from ToolPart for saving
export interface ToolDataForSave {
  uiType: UIType;
  toolName: string;
  toolCallId?: string;
  input: unknown;
  output: unknown;
  errorText?: string;
  state: "output-available" | "output-error";
  widgetDebugInfo?: {
    csp?: WidgetCsp;
    protocol?: "mcp-apps" | "openai-apps";
    modelContext?: unknown;
  };
  // MCP-specific
  resourceUri?: string;
  toolsMetadata?: unknown;
  widgetPermissions?: unknown;
  widgetPermissive?: boolean;
  // OpenAI-specific
  outputTemplate?: string;
  serverInfo?: ServerInfo;
  // Cached widget HTML for offline rendering
  widgetHtml?: string;
  // Tool metadata (contains openai/outputTemplate and other metadata)
  toolMetadata?: Record<string, unknown>;
}

// Form data for save dialog
export interface SaveViewFormData {
  name: string;
  description?: string;
  category?: string;
  tags?: string[];
  prefersBorder?: boolean;
  defaultContext?: DisplayContext;
}

interface UseSaveViewOptions {
  isAuthenticated: boolean;
  projectId: string | null;
  serverName: string;
  existingViewNames?: Set<string>;
}

// Generate a unique view name by appending (2), (3), etc. if needed
function generateUniqueViewName(
  baseName: string,
  existingNames: Set<string>,
): string {
  if (!existingNames.has(baseName)) return baseName;
  let suffix = 2;
  while (existingNames.has(`${baseName} (${suffix})`)) suffix++;
  return `${baseName} (${suffix})`;
}

export function useSaveView({
  isAuthenticated,
  projectId,
  serverName,
  existingViewNames = new Set(),
}: UseSaveViewOptions) {
  const [isSaving, setIsSaving] = useState(false);

  // Get current display context from shared utility
  const currentDisplayContext = useCurrentDisplayContext();

  // `createMcpView` is now the only write path; the OpenAI mutation is
  // kept on the hook for legacy read/delete callers only.
  const { createMcpView, generateMcpUploadUrl } = useViewMutations();

  const { serversByName } = useProjectServers({
    isAuthenticated,
    projectId,
  });

  const { createServer } = useServerMutations();

  // Get or create server ID
  const getOrCreateServerId = useCallback(
    async (name: string): Promise<string> => {
      // Check if server already exists
      const existingId = serversByName.get(name);
      if (existingId) {
        return existingId;
      }

      // Create new server
      if (!projectId) {
        throw new Error("No project selected");
      }

      const serverId = await createServer({
        projectId,
        name,
        enabled: true,
        transportType: "http", // Default to HTTP for views
      });

      return serverId;
    },
    [serversByName, projectId, createServer],
  );

  // Upload output blob to Convex storage. The protocol arg is kept on
  // the signature for compatibility with callers but the upload URL
  // now always comes from the canonical mcpAppViews path.
  const uploadOutputBlob = useCallback(
    async (output: unknown): Promise<string> => {
      const uploadUrl = await generateMcpUploadUrl({});

      const blob = new Blob([JSON.stringify(output)], {
        type: "application/json",
      });

      const response = await fetch(uploadUrl, {
        method: "POST",
        body: blob,
      });

      if (!response.ok) {
        throw new Error("Failed to upload output blob");
      }

      const result = await response.json();
      return result.storageId;
    },
    [generateMcpUploadUrl],
  );

  // Upload widget HTML blob to Convex storage (for offline rendering).
  const uploadWidgetHtmlBlob = useCallback(
    async (html: string): Promise<string> => {
      const uploadUrl = await generateMcpUploadUrl({});

      const blob = new Blob([html], {
        type: "text/html",
      });

      const response = await fetch(uploadUrl, {
        method: "POST",
        body: blob,
      });

      if (!response.ok) {
        throw new Error("Failed to upload widget HTML blob");
      }

      const result = await response.json();
      return result.storageId;
    },
    [generateMcpUploadUrl],
  );

  // Save view
  const saveView = useCallback(
    async (toolData: ToolDataForSave, formData: SaveViewFormData) => {
      if (!projectId) {
        toast.error("No project selected");
        return null;
      }

      if (!formData.name.trim()) {
        toast.error("View name is required");
        return null;
      }

      setIsSaving(true);

      try {
        // Determine protocol
        const protocol =
          toolData.uiType === UIType.OPENAI_SDK ? "openai-apps" : "mcp-apps";

        // Get or create server ID
        const serverId = await getOrCreateServerId(serverName);

        // Upload output blob
        const toolOutputBlobId = await uploadOutputBlob(toolData.output);

        // Upload widget HTML blob (for offline rendering - both MCP and OpenAI apps)
        let widgetHtmlBlobId: string | undefined;
        if (toolData.widgetHtml) {
          widgetHtmlBlobId = await uploadWidgetHtmlBlob(toolData.widgetHtml);
        }

        // Prepare base args
        const baseArgs = {
          projectId,
          serverId,
          name: formData.name.trim(),
          description: formData.description,
          toolName: toolData.toolName,
          toolState: toolData.state,
          toolInput: toolData.input,
          toolOutputBlobId,
          toolErrorText: toolData.errorText,
          prefersBorder: formData.prefersBorder,
          tags: formData.tags,
          category: formData.category,
          defaultContext: formData.defaultContext,
          toolMetadata: toolData.toolMetadata,
        };

        // Unified save path per SEP-1865 (MCP Apps, Stable 2026-01-26):
        // all writes go through `mcpAppViews:create`. OpenAI-origin
        // tool results pass `outputTemplate` as a legacy alias which
        // the backend normalizer maps to `resourceUri`. Renderer
        // choice at read time is driven by `injectedOpenAiCompat` and
        // `detectUIType(toolMetadata)` — never by a protocol field.
        const rawCsp = toolData.widgetDebugInfo?.csp;
        const filteredWidgetCsp = rawCsp
          ? {
              connectDomains: rawCsp.connectDomains,
              resourceDomains: rawCsp.resourceDomains,
              frameDomains: rawCsp.frameDomains,
              baseUriDomains: rawCsp.baseUriDomains,
            }
          : undefined;

        // Canonical fallback URI is `ui://` per SEP-1865. The previous
        // `mcp://` fallback was a SEP violation and is what motivates
        // the paired backend Phase A loosening; once that ships we can
        // tighten the server back to a hard reject.
        const fallbackResourceUri = `ui://mcpjam/${serverName}/${toolData.toolName}`;
        const resourceUri =
          toolData.resourceUri ||
          (toolData.outputTemplate?.startsWith("ui://")
            ? toolData.outputTemplate
            : fallbackResourceUri);

        const isOpenAIOrigin = protocol === "openai-apps";

        const viewId: string = await createMcpView({
          ...baseArgs,
          resourceUri,
          toolsMetadata: toolData.toolsMetadata,
          widgetCsp: filteredWidgetCsp,
          widgetPermissions: toolData.widgetPermissions,
          widgetPermissive: toolData.widgetPermissive,
          widgetHtmlBlobId,
          // Legacy aliases (input-only on the backend normalizer):
          outputTemplate: isOpenAIOrigin ? toolData.outputTemplate : undefined,
          serverInfo: isOpenAIOrigin ? toolData.serverInfo : undefined,
          // Documentation-only provenance:
          viewOriginProtocol: isOpenAIOrigin ? "openai-apps" : "mcp-apps",
        });

        toast.success(`View "${formData.name}" saved successfully`);
        return viewId;
      } catch (error) {
        console.error("Failed to save view:", error);
        const message =
          error instanceof Error ? error.message : "Failed to save view";
        toast.error(message);
        return null;
      } finally {
        setIsSaving(false);
      }
    },
    [
      projectId,
      serverName,
      getOrCreateServerId,
      uploadOutputBlob,
      uploadWidgetHtmlBlob,
      createMcpView,
    ],
  );

  // Instant save: uses server-tool name as view name with automatic duplicate handling
  const saveViewInstant = useCallback(
    async (toolData: ToolDataForSave) => {
      const baseName = `${serverName}-${toolData.toolName}`;
      const uniqueName = generateUniqueViewName(baseName, existingViewNames);
      return saveView(toolData, {
        name: uniqueName,
        defaultContext: currentDisplayContext,
      });
    },
    [saveView, serverName, existingViewNames, currentDisplayContext],
  );

  return {
    saveView,
    saveViewInstant,
    isSaving,
  };
}
