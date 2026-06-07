/**
 * host-app-bridge.ts — framework-free MCP Apps host bridge surface (SEP-1865)
 *
 * Extracted from `mcp-apps-renderer.tsx` so the host-side AppBridge wiring,
 * the capability-gated bridge handler installation, and the iframe sandbox
 * attribute construction can be reused outside React — specifically by the
 * eval browser harness (`server/utils/mcp-app-browser-harness.ts`) which must
 * behave like the production renderer when it mounts a widget in headless
 * Chromium.
 *
 * Design contract:
 *   - This module is PURE JS: no React, no DOM-effect ownership, no Zustand.
 *   - All host-environment effects (open a link, read a resource, dispatch a
 *     tool call, mutate display mode, animate the iframe) are injected as
 *     callbacks. The renderer binds its `useRef`/`useState`/`useCallback`
 *     machinery to these inputs; the harness binds its own.
 *   - The genuinely-shared *correctness surface* lives here verbatim:
 *     capability gating (advertise = enforce), the model-only visibility
 *     check, the matrix-gated `sendToolCancelled` policy, and the app-tool
 *     invocation lifecycle. The harness needs all of it to match production.
 *
 * React-specific concerns (state updates, refs, reconnection) stay in the
 * renderer. See `mcp-apps-renderer.tsx` for the adapter that consumes this.
 */

import {
  AppBridge,
  type McpUiHostCapabilities,
  type McpUiHostContext,
  type McpUiResourceCsp,
  type McpUiResourcePermissions,
} from "@modelcontextprotocol/ext-apps/app-bridge";
import { isVisibleToModelOnly } from "@/lib/mcp-ui/tool-visibility";
import type { AppToolInvocationUpdate } from "../app-tool-invocations";

// Re-export the shared SEP-1865 visibility helpers and the iframe sandbox
// attribute resolver so harness consumers can pull the full host surface from
// a single framework-free module ("alongside the bridge").
export {
  getToolVisibility,
  isVisibleToModelOnly,
  isVisibleToAppOnly,
} from "@/lib/mcp-ui/tool-visibility";
export {
  DEFAULT_IFRAME_SANDBOX,
  buildOuterAllowAttribute,
  buildOuterSandboxAttribute,
  resolveIframeSandboxPolicy,
} from "@/lib/mcp-ui/iframe-sandbox-policy";

/* ------------------------------------------------------------------ *
 * Host AppBridge construction
 * ------------------------------------------------------------------ */

/**
 * Construct a host-side AppBridge with the resolved capabilities + sandbox
 * slice + host context. Mirrors the inline `new AppBridge(...)` the renderer
 * builds. The caller wires a transport and calls `bridge.connect(transport)`.
 */
export function createHostAppBridge(opts: {
  hostInfo: { name: string; version: string };
  hostCapabilities: Omit<McpUiHostCapabilities, "sandbox">;
  sandbox?: {
    csp?: McpUiResourceCsp;
    permissions?: McpUiResourcePermissions;
  };
  hostContext?: McpUiHostContext;
}): AppBridge {
  return new AppBridge(
    null,
    opts.hostInfo,
    {
      ...opts.hostCapabilities,
      sandbox: opts.sandbox ?? {},
    },
    { hostContext: opts.hostContext ?? {} },
  );
}

/* ------------------------------------------------------------------ *
 * Bridge handler installation (the correctness surface)
 * ------------------------------------------------------------------ */

// Derive result/param types from the AppBridge handler signatures so we never
// import the MCP v1 SDK types package directly (forbidden in client/src by the
// `check:mcp-v1-runtime-imports` guard). The types flow through ext-apps.
type CallToolReturn = Awaited<ReturnType<NonNullable<AppBridge["oncalltool"]>>>;
type ReadResourceReturn = Awaited<
  ReturnType<NonNullable<AppBridge["onreadresource"]>>
>;
type ListResourcesParams = Parameters<
  NonNullable<AppBridge["onlistresources"]>
>[0];
type ListResourcesReturn = Awaited<
  ReturnType<NonNullable<AppBridge["onlistresources"]>>
>;
type ListResourceTemplatesParams = Parameters<
  NonNullable<AppBridge["onlistresourcetemplates"]>
>[0];
type ListResourceTemplatesReturn = Awaited<
  ReturnType<NonNullable<AppBridge["onlistresourcetemplates"]>>
>;
type ListPromptsReturn = Awaited<
  ReturnType<NonNullable<AppBridge["onlistprompts"]>>
>;
type LoggingMessageParams = Parameters<
  NonNullable<AppBridge["onloggingmessage"]>
>[0];
type SizeChangeParams = Parameters<NonNullable<AppBridge["onsizechange"]>>[0];
type RequestDisplayModeParams = Parameters<
  NonNullable<AppBridge["onrequestdisplaymode"]>
>[0];
type RequestDisplayModeReturn = Awaited<
  ReturnType<NonNullable<AppBridge["onrequestdisplaymode"]>>
>;
type UpdateModelContextParams = Parameters<
  NonNullable<AppBridge["onupdatemodelcontext"]>
>[0];
type DownloadFileParams = Parameters<
  NonNullable<AppBridge["ondownloadfile"]>
>[0];
type DownloadFileReturn = Awaited<
  ReturnType<NonNullable<AppBridge["ondownloadfile"]>>
>;

export type WidgetDebugDirection = "host-to-ui" | "ui-to-host";

/**
 * The minimal slice of the MCP Apps capabilities matrix that the shared
 * correctness surface reads. `null` means "no matrix configured" (treat as
 * all-allowed), matching the renderer's `mcpAppsCapabilitiesRef.current`.
 */
export interface HostBridgeMatrix {
  /** When false, suppress the side-channel `sendToolCancelled` notification. */
  toolCancelled?: boolean;
  /** When false, do not install the view-initiated teardown handler. */
  requestTeardown?: boolean;
}

/**
 * Host-environment effects injected by the consumer. Every callback is
 * optional; an unset callback means the corresponding host behavior is a no-op
 * (the bridge handler is still installed when its capability is advertised, so
 * the widget sees a well-formed response).
 */
export interface HostBridgeCallbacks {
  /** Fires on `ui/initialize` completion. The renderer drives all of its
   *  init-time state from here (ready flag, display modes, app-provided-tools
   *  detection + auto-promote); the harness records render readiness. */
  onAppInitialized?: (bridge: AppBridge) => void;
  /** `ui/message` text content (host follow-up). */
  onSendFollowUp?: (text: string) => void;
  /** `ui/open-link`. */
  onOpenLink?: (url: string) => void;
  /** App-initiated `tools/call` dispatcher. Resolves to a CallToolResult. */
  onCallTool?: (
    name: string,
    args: Record<string, unknown>,
  ) => Promise<CallToolReturn>;
  /** App-tool invocation lifecycle updates (running/success/error). */
  onAppToolInvocation?: (update: AppToolInvocationUpdate) => void;
  /** `resources/read`. */
  onReadResource?: (uri: string) => Promise<ReadResourceReturn>;
  /** `resources/list`. */
  onListResources?: (
    params: ListResourcesParams,
  ) => Promise<ListResourcesReturn>;
  /** `resources/templates/list`. */
  onListResourceTemplates?: (
    params: ListResourceTemplatesParams,
  ) => Promise<ListResourceTemplatesReturn>;
  /** `prompts/list`. */
  onListPrompts?: () => Promise<ListPromptsReturn>;
  /** `logging/message`. */
  onLoggingMessage?: (params: LoggingMessageParams) => void;
  /** `ui/notifications/size-changed`. */
  onSizeChange?: (params: SizeChangeParams) => void;
  /** `ui/request-display-mode`. Returns the granted mode. */
  onRequestDisplayMode?: (
    params: RequestDisplayModeParams,
  ) => Promise<RequestDisplayModeReturn> | RequestDisplayModeReturn;
  /** `ui/update-model-context`. */
  onUpdateModelContext?: (
    toolCallId: string,
    params: UpdateModelContextParams,
  ) => void;
  /** `ui/download-file`. */
  onDownloadFile?: (
    params: DownloadFileParams,
  ) => Promise<DownloadFileReturn> | DownloadFileReturn;
  /** `ui/notifications/request-teardown` (after host-side teardownResource). */
  onRequestTeardown?: (toolCallId: string) => void;
}

export interface RegisterHostBridgeHandlersOptions {
  /**
   * Resolved host capabilities (vendor-trait surface advertised in
   * `ui/initialize`). Gating here is advertise = enforce: a handler is only
   * installed when its capability is true.
   */
  effectiveHostCapabilities: Omit<McpUiHostCapabilities, "sandbox">;
  /** Read the MCP Apps capabilities matrix at call/registration time. */
  getMatrix?: () => HostBridgeMatrix | null;
  /** Look up tool metadata by name for the model-only visibility check. */
  getToolMetadata?: (name: string) => Record<string, unknown> | undefined;
  /** Current parent tool-call id (correlates app-tool invocations + teardown). */
  getToolCallId?: () => string;
  /** Monotonic sequence source for app-tool invocation ids. Defaults to an
   *  internal per-registration counter; the renderer passes a shared ref so
   *  inline + modal bridges never collide on an invocation id. */
  nextInvocationSequence?: () => number;
  /** Host-environment effect callbacks. */
  callbacks: HostBridgeCallbacks;
  /** Diagnostic sink (traffic / widget-debug). */
  onWidgetDebug?: (
    direction: WidgetDebugDirection,
    method: string,
    data: Record<string, unknown>,
  ) => void;
}

/**
 * Install the SEP-1865 host bridge handlers on `bridge`, gated by
 * `effectiveHostCapabilities` and the capabilities matrix. This is the
 * production correctness surface — capability gating, model-only visibility,
 * matrix-gated `sendToolCancelled`, and the app-tool invocation lifecycle —
 * lifted out of the React renderer so the eval harness shares it verbatim.
 */
export function registerHostBridgeHandlers(
  bridge: AppBridge,
  options: RegisterHostBridgeHandlersOptions,
): void {
  const {
    effectiveHostCapabilities,
    getMatrix,
    getToolMetadata,
    getToolCallId,
    callbacks,
    onWidgetDebug,
  } = options;

  let internalSeq = 0;
  const nextSeq = options.nextInvocationSequence ?? (() => internalSeq++);
  const currentToolCallId = () => getToolCallId?.() ?? "";

  bridge.oninitialized = () => {
    callbacks.onAppInitialized?.(bridge);
  };

  // SEP-1865 bridge handlers are gated by `effectiveHostCapabilities` alone.
  // They are a SEPARATE surface from the `window.openai` shim; folding the
  // shim matrix in here would break the advertise = enforce contract.
  if (effectiveHostCapabilities.message) {
    bridge.onmessage = async ({ content }) => {
      const textContent = content.find((item) => item.type === "text")?.text;
      if (textContent) {
        callbacks.onSendFollowUp?.(textContent);
      }
      return {};
    };
  }

  if (effectiveHostCapabilities.openLinks) {
    bridge.onopenlink = async ({ url }) => {
      if (url) {
        callbacks.onOpenLink?.(url);
      }
      return {};
    };
  }

  if (effectiveHostCapabilities.serverTools) {
    // Matrix-gated `sendToolCancelled`: Microsoft 365 Copilot does not deliver
    // `ui/notifications/tool-cancelled`; simulated Copilot hosts must not see
    // the cancelled callback even when the underlying tool throws. The handler
    // still THROWS so the request/response path reports an error to the widget
    // — only the side-channel notification is suppressed.
    const sendToolCancelledIfAllowed = (reason: string) => {
      const matrix = getMatrix?.() ?? null;
      if (matrix !== null && matrix.toolCancelled === false) return;
      void bridge.sendToolCancelled({ reason });
    };
    bridge.oncalltool = async ({ name, arguments: args }, _extra) => {
      // Model-only tools (visibility: ["model"]) are not callable by apps.
      const calledToolMeta = getToolMetadata?.(name);
      if (isVisibleToModelOnly(calledToolMeta)) {
        const error = new Error(
          `Tool "${name}" is not callable by apps (visibility: model-only)`,
        );
        sendToolCancelledIfAllowed(error.message);
        throw error;
      }

      const invocationInput = (args ?? {}) as Record<string, unknown>;
      const parentToolCallId = currentToolCallId();
      const invocationId = `${parentToolCallId}:app-tool:${nextSeq()}`;
      const startedAt = Date.now();
      callbacks.onAppToolInvocation?.({
        id: invocationId,
        parentToolCallId,
        toolName: name,
        input: invocationInput,
        status: "running",
        startedAt,
      });

      if (!callbacks.onCallTool) {
        const error = new Error("Tool calls not supported");
        callbacks.onAppToolInvocation?.({
          id: invocationId,
          parentToolCallId,
          toolName: name,
          input: invocationInput,
          errorText: error.message,
          status: "error",
          startedAt,
          completedAt: Date.now(),
        });
        sendToolCancelledIfAllowed(error.message);
        throw error;
      }

      try {
        const result = await callbacks.onCallTool(name, invocationInput);
        callbacks.onAppToolInvocation?.({
          id: invocationId,
          parentToolCallId,
          toolName: name,
          input: invocationInput,
          output: result,
          status: "success",
          startedAt,
          completedAt: Date.now(),
        });
        return result;
      } catch (error) {
        const errorText =
          error instanceof Error ? error.message : String(error);
        callbacks.onAppToolInvocation?.({
          id: invocationId,
          parentToolCallId,
          toolName: name,
          input: invocationInput,
          errorText,
          status: "error",
          startedAt,
          completedAt: Date.now(),
        });
        sendToolCancelledIfAllowed(errorText);
        throw error;
      }
    };
  }

  if (effectiveHostCapabilities.serverResources) {
    bridge.onreadresource = async ({ uri }) => {
      if (!callbacks.onReadResource) {
        throw new Error("Resource reads not supported");
      }
      return callbacks.onReadResource(uri);
    };

    bridge.onlistresources = async (params) => {
      if (!callbacks.onListResources) {
        return { resources: [] } as ListResourcesReturn;
      }
      return callbacks.onListResources(params);
    };

    bridge.onlistresourcetemplates = async (params) => {
      if (!callbacks.onListResourceTemplates) {
        return { resourceTemplates: [] } as ListResourceTemplatesReturn;
      }
      return callbacks.onListResourceTemplates(params);
    };
  }

  // onlistprompts: unconditional — no serverPrompts cap in SEP-1865.
  bridge.onlistprompts = async () => {
    if (!callbacks.onListPrompts) {
      return { prompts: [] } as ListPromptsReturn;
    }
    return callbacks.onListPrompts();
  };

  if (effectiveHostCapabilities.logging) {
    bridge.onloggingmessage = (params) => {
      callbacks.onLoggingMessage?.(params);
    };
  }

  // Size changes are unconditional in the renderer (the host shell owns layout).
  bridge.onsizechange = (params) => {
    callbacks.onSizeChange?.(params);
  };

  bridge.onrequestdisplaymode = async (params) => {
    if (callbacks.onRequestDisplayMode) {
      return callbacks.onRequestDisplayMode(params);
    }
    // No host display-mode policy → echo the requested mode (default inline).
    return { mode: params.mode ?? "inline" } as RequestDisplayModeReturn;
  };

  if (effectiveHostCapabilities.updateModelContext) {
    bridge.onupdatemodelcontext = async (params) => {
      callbacks.onUpdateModelContext?.(currentToolCallId(), params);
      return {};
    };
  }

  if (effectiveHostCapabilities.downloadFile) {
    bridge.ondownloadfile = async (params) => {
      if (!callbacks.onDownloadFile) {
        return {} as DownloadFileReturn;
      }
      return callbacks.onDownloadFile(params);
    };
  }

  // `requestTeardown` is a behavior gate on the matrix (not a wire-advertised
  // host capability); presets that set it false simulate hosts that ignore
  // view-initiated teardown by leaving the handler unassigned.
  if ((getMatrix?.() ?? null)?.requestTeardown !== false) {
    bridge.onrequestteardown = async () => {
      onWidgetDebug?.("ui-to-host", "ui/notifications/request-teardown", {});
      try {
        await bridge.teardownResource({});
      } catch (err) {
        // Teardown is best-effort; proceed to unmount even if the view never
        // acks so a misbehaving widget can't block its own removal.
        onWidgetDebug?.("host-to-ui", "ui/resource-teardown", {
          error: err instanceof Error ? err.message : String(err),
        });
      }
      callbacks.onRequestTeardown?.(currentToolCallId());
    };
  }
}
