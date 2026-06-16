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
import {
  resolveCanonicalResourceUri,
  synthesizeFallbackResourceUri,
} from "@/lib/mcp-ui/synthesize-fallback-uri";
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
  /**
   * Whether the cached `widgetHtml` was captured with the OpenAI Apps
   * SDK `window.openai` shim injected. Persisted alongside the blob so
   * replay agrees with the bytes on disk under a different host
   * config. Sourced from `widgetDebugStore.widgets[toolCallId].
   * injectedOpenAiCompat`, which is stamped by the renderer at fetch
   * time.
   */
  injectedOpenAiCompat?: boolean;
  /**
   * Per-method `window.openai.*` surface the runtime exposed when
   * `widgetHtml` was captured. Sibling of `injectedOpenAiCompat`; the
   * boolean alone only answers "was a shim injected?", whereas the
   * matrix tells replay/debug WHICH surface was injected. Sourced
   * from the same widget-debug-store entry.
   */
  injectedOpenAiCompatCapabilities?: import("@/lib/client-styles").OpenAiAppsCapabilities;
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

  const { createServerIfMissing } = useServerMutations();

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

      // create-if-missing rather than create: `serversByName` can be stale or
      // still loading, so a plain create would throw "already exists" on a row
      // we just didn't see yet. This returns the existing server in that case.
      const serverId = await createServerIfMissing({
        projectId,
        name,
        enabled: true,
        transportType: "http", // Default to HTTP for views
      });

      return serverId;
    },
    [serversByName, projectId, createServerIfMissing],
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
        // `mcp://` fallback was a SEP violation; this form is also
        // collision-safe (uses the immutable `serverId` rather than
        // the display `serverName`) and URI-safe (`toolName` is hashed
        // so spaces, slashes, and other unescaped characters cannot
        // produce ambiguous paths). Two saves of the same tool on the
        // same server are idempotent because the hash is
        // deterministic.
        const fallbackResourceUri = synthesizeFallbackResourceUri({
          serverId,
          toolName: toolData.toolName,
        });
        const liveOutputTemplate = toolData.outputTemplate?.trim();
        // `toolData.resourceUri` comes from `getUIResourceUri()` in
        // part-switch.tsx, which for OpenAI-origin tools returns the
        // raw `openai/outputTemplate` value verbatim — any scheme. We
        // must gate on `ui://` here, otherwise a non-compliant
        // template like `https://...` lands in the canonical column
        // bypassing the fallback synthesizer entirely.
        const resourceUri = resolveCanonicalResourceUri({
          candidate: toolData.resourceUri,
          legacyOutputTemplate: liveOutputTemplate,
          fallback: fallbackResourceUri,
        });

        const isOpenAIOrigin = protocol === "openai-apps";

        const viewId: string = await createMcpView({
          ...baseArgs,
          resourceUri,
          toolsMetadata: toolData.toolsMetadata,
          widgetCsp: filteredWidgetCsp,
          widgetPermissions: toolData.widgetPermissions,
          widgetPermissive: toolData.widgetPermissive,
          widgetHtmlBlobId,
          // Persist the shim flag + per-method capability surface
          // alongside the cached HTML so replay can reproduce the
          // original `window.openai` API surface even after the
          // active host config has changed. Only meaningful when
          // `widgetHtmlBlobId` is present; the backend tolerates
          // either field being absent (pre-feature rows hash
          // identically).
          injectedOpenAiCompat: widgetHtmlBlobId
            ? toolData.injectedOpenAiCompat
            : undefined,
          injectedOpenAiCompatCapabilities: widgetHtmlBlobId
            ? toolData.injectedOpenAiCompatCapabilities
            : undefined,
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
