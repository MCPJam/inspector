import { useState, useCallback } from "react";
import { toast } from "sonner";
import {
  useViewMutations,
  useWorkspaceServers,
  useServerMutations,
  type DisplayContext,
  type WidgetCsp,
  type ServerInfo,
} from "./useViews";
import { UIType } from "@/lib/mcp-ui/mcp-apps-utils";

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
  workspaceId: string | null;
  serverName: string;
}

export function useSaveView({
  isAuthenticated,
  workspaceId,
  serverName,
}: UseSaveViewOptions) {
  const [isSaving, setIsSaving] = useState(false);

  const {
    createMcpView,
    createOpenaiView,
    generateMcpUploadUrl,
    generateOpenaiUploadUrl,
  } = useViewMutations();

  const { serversByName } = useWorkspaceServers({
    isAuthenticated,
    workspaceId,
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
      if (!workspaceId) {
        throw new Error("No workspace selected");
      }

      const serverId = await createServer({
        workspaceId,
        name,
        enabled: true,
        transportType: "http", // Default to HTTP for views
      });

      return serverId;
    },
    [serversByName, workspaceId, createServer]
  );

  // Upload output blob to Convex storage
  const uploadOutputBlob = useCallback(
    async (
      output: unknown,
      protocol: "mcp-apps" | "openai-apps"
    ): Promise<string> => {
      // Generate upload URL based on protocol
      const uploadUrl =
        protocol === "mcp-apps"
          ? await generateMcpUploadUrl({})
          : await generateOpenaiUploadUrl({});

      // Create blob from output
      const blob = new Blob([JSON.stringify(output)], {
        type: "application/json",
      });

      // Upload blob
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
    [generateMcpUploadUrl, generateOpenaiUploadUrl]
  );

  // Upload widget HTML blob to Convex storage (for offline rendering)
  const uploadWidgetHtmlBlob = useCallback(
    async (html: string): Promise<string> => {
      // Only MCP apps support widget HTML caching
      const uploadUrl = await generateMcpUploadUrl({});

      // Create blob from HTML
      const blob = new Blob([html], {
        type: "text/html",
      });

      // Upload blob
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
    [generateMcpUploadUrl]
  );

  // Save view
  const saveView = useCallback(
    async (toolData: ToolDataForSave, formData: SaveViewFormData) => {
      if (!workspaceId) {
        toast.error("No workspace selected");
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
        const toolOutputBlobId = await uploadOutputBlob(toolData.output, protocol);

        // Upload widget HTML blob (for MCP apps with cached HTML)
        let widgetHtmlBlobId: string | undefined;
        if (protocol === "mcp-apps" && toolData.widgetHtml) {
          widgetHtmlBlobId = await uploadWidgetHtmlBlob(toolData.widgetHtml);
        }

        // Prepare base args
        const baseArgs = {
          workspaceId,
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
        };

        let viewId: string;

        if (protocol === "mcp-apps") {
          // Filter widgetCsp to only include schema-allowed fields
          // (excludes runtime debug data like mode, violations, widgetDeclared)
          const rawCsp = toolData.widgetDebugInfo?.csp;
          const filteredWidgetCsp = rawCsp
            ? {
                connectDomains: rawCsp.connectDomains,
                resourceDomains: rawCsp.resourceDomains,
                frameDomains: rawCsp.frameDomains,
                baseUriDomains: rawCsp.baseUriDomains,
              }
            : undefined;

          // MCP-specific save
          viewId = await createMcpView({
            ...baseArgs,
            resourceUri: toolData.resourceUri || `mcp://${serverName}/${toolData.toolName}`,
            toolsMetadata: toolData.toolsMetadata,
            widgetCsp: filteredWidgetCsp,
            widgetPermissions: toolData.widgetPermissions,
            widgetPermissive: toolData.widgetPermissive,
            widgetHtmlBlobId, // Include cached widget HTML for offline rendering
          });
        } else {
          // OpenAI-specific save
          viewId = await createOpenaiView({
            ...baseArgs,
            outputTemplate: toolData.outputTemplate || "",
            serverInfo: toolData.serverInfo,
          });
        }

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
      workspaceId,
      serverName,
      getOrCreateServerId,
      uploadOutputBlob,
      uploadWidgetHtmlBlob,
      createMcpView,
      createOpenaiView,
    ]
  );

  return {
    saveView,
    isSaving,
  };
}
