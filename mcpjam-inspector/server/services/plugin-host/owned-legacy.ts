import { ProtocolError, ProtocolErrorCode } from "@modelcontextprotocol/client";
import type { MCPClientManager, MCPClientManagerOptions } from "@mcpjam/sdk";
import { HostedElicitationBridge } from "../../routes/web/hosted-elicitation.js";
import {
  OPENAI_LEGACY_FORM_EXTENSION,
  OPENAI_LEGACY_FORM_METHOD,
  openAILegacyFormSchemas,
  parseOpenAIForm,
} from "../../../shared/plugin-extensions/wire.js";
import {
  compilePluginForm,
  pluginFormSchemaTooLarge,
  type PluginFormProfile,
  validatePluginFormContent,
} from "../../../shared/plugin-extensions/form-plan.js";
import {
  PluginInvocationError,
  type ResolvedInvocationContext,
} from "./invocation.js";
import type { HostedElicitationEvent } from "../../../shared/hosted-elicitation.js";
import { OPENAI_FORM_CLIENT_EXTENSION_KEYS } from "@mcpjam/sdk/host-config/internal";

/** Shared owned legacy dispatch, independent of connection creation or execution origin. */
export function createOwnedPluginLegacyForms(deps: {
  bearer: string;
  projectId: string;
  workspaceId: string;
  hostId: string;
  hostRevision: string;
  serverId: string;
  serverName?: () => string | undefined;
  signal: AbortSignal;
  manager: () => MCPClientManager | undefined;
  assertCurrent: () => Promise<unknown>;
  /** Actual host services, never inferred from extension metadata. */
  profile: PluginFormProfile | (() => PluginFormProfile);
  /** Original operation binds the pending form to its owned service lifetime. */
  bindForm?: (input: {
    authorization: ResolvedInvocationContext;
    invocationId: string;
    signal: AbortSignal;
    rendezvousId: string;
    serverId: string;
    schema: unknown;
    expiresAt: number;
  }) => ReturnType<
    NonNullable<
      ConstructorParameters<typeof HostedElicitationBridge>[0]["bindPluginForm"]
    >
  >;
  onEvent?: (event: HostedElicitationEvent) => void;
}) {
  const denied = () => new PluginInvocationError("INSTANCE_DENIED");
  let operation:
    | {
        authorization: ResolvedInvocationContext;
        invocationId: string;
        signal: AbortSignal;
      }
    | undefined;
  const serverNamesById = { [deps.serverId]: "MCP server" };
  const bridge = new HostedElicitationBridge({
    convexBearer: deps.bearer,
    projectId: deps.projectId,
    pluginWorkspaceId: deps.workspaceId,
    serverNamesById,
    abortSignal: deps.signal,
    bindPluginForm: deps.bindForm
      ? async (input) => {
          const active = operation;
          if (!active || input.serverId !== deps.serverId) throw denied();
          active.signal.throwIfAborted();
          await deps.assertCurrent();
          if (operation !== active) throw denied();
          const binding = await deps.bindForm!({ ...input, ...active });
          try {
            active.signal.throwIfAborted();
            await deps.assertCurrent();
            if (operation !== active) throw denied();
            return binding;
          } catch (error) {
            binding.release();
            throw error;
          }
        }
      : undefined,
  });

  if (deps.onEvent)
    bridge.attachStreamWriter({
      write: (chunk) => {
        if (chunk.type === "data-elicitation")
          deps.onEvent!(chunk.data as HostedElicitationEvent);
      },
    });

  const binding = {
    method: OPENAI_LEGACY_FORM_METHOD,
    schemas: openAILegacyFormSchemas,
    waitsForInput: true,
    legacyClaim: OPENAI_LEGACY_FORM_EXTENSION,
    handler: async (request: { params?: Record<string, unknown> }) => {
      const active = operation;
      if (!active) throw denied();
      active.signal.throwIfAborted();
      // Modern extension mapping remains assumed: this handler serves legacy only.
      if (
        deps.manager()?.getInitializationInfo(deps.serverId)
          ?.protocolVersion === "2026-07-28"
      )
        throw new ProtocolError(
          ProtocolErrorCode.MethodNotFound,
          "Legacy extension forms are unavailable on this wire",
        );
      await deps.assertCurrent();
      if (operation !== active) throw denied();
      serverNamesById[deps.serverId] = deps.serverName?.() || "MCP server";
      // The envelope only: the requested schema arrives exactly as sent.
      const params = parseOpenAIForm(request.params);
      if (pluginFormSchemaTooLarge(params.requestedSchema))
        throw new ProtocolError(
          ProtocolErrorCode.InvalidParams,
          "Plugin form schema is too large",
        );
      let plan;
      try {
        plan = compilePluginForm(params.requestedSchema, {
          ...(typeof deps.profile === "function"
            ? deps.profile()
            : deps.profile),
          origin: active.authorization.origin === "app" ? "mcp-app" : "server",
        });
      } catch {
        // Unsupported as a whole: an input type or constraint this client
        // doesn't support, a broken server rule, or a missing host service.
        // Deliver it unchanged so the card says why and Logs records it;
        // nothing is partially displayed. It can only be declined or
        // cancelled, and a forged accept is refused below.
        plan = undefined;
      }
      const result = await bridge.callback({
        requestId: crypto.randomUUID(),
        serverId: deps.serverId,
        mode: "form",
        message: params.message,
        schema: plan?.schema ?? params.requestedSchema,
      });
      await deps.assertCurrent();
      if (operation !== active) throw denied();
      if (
        result.action === "accept" &&
        (!plan || !validatePluginFormContent(plan, result.content ?? {}).valid)
      )
        throw new ProtocolError(
          ProtocolErrorCode.InvalidParams,
          "Plugin form answer does not satisfy its schema",
        );
      return result;
    },
  };

  return {
    binding: binding satisfies NonNullable<
      MCPClientManagerOptions["extensionRequestHandlers"]
    >[string][number],
    async run<T>(
      authorization: ResolvedInvocationContext,
      invocationId: string,
      signal: AbortSignal,
      execute: () => Promise<T>,
    ): Promise<T> {
      if (operation) throw new PluginInvocationError("INSTANCE_REQUEST_BUSY");
      signal.throwIfAborted();
      operation = { authorization, invocationId, signal };
      try {
        return await execute();
      } finally {
        operation = undefined;
      }
    },
    dispose: () => bridge.dispose(),
  };
}

/**
 * The OpenAI form extensions a connection advertises. Claimed only when
 * this host installed something that answers them (the legacy
 * `openai/elicitation/create` handler, or the plugin MRTR adapter) and the
 * client's forms extension is on. A client capture that claims them is
 * otherwise withheld, so a server never sends a form nothing here can show
 * (MethodNotFound on the legacy wire, a partial standard form on MRTR).
 */
export function installedFormClientCapabilities(
  base: Record<string, unknown> | undefined,
  installed: { legacy?: { binding: unknown }; mrtr: boolean },
  forms: boolean | undefined,
): Record<string, unknown> | undefined {
  if (installed.legacy && forms !== false)
    return ownedLegacyFormCapabilities(base ?? {}, installed.legacy);
  if (!base || (installed.mrtr && forms !== false)) return base;
  const capabilities = { ...base };
  for (const field of ["extensions", "experimental"] as const) {
    const value = capabilities[field];
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const kept = Object.fromEntries(
      Object.entries(value).filter(
        ([key]) =>
          !(OPENAI_FORM_CLIENT_EXTENSION_KEYS as readonly string[]).includes(
            key,
          ),
      ),
    );
    if (Object.keys(kept).length) capabilities[field] = kept;
    else delete capabilities[field];
  }
  return capabilities;
}

/**
 * Whether the legacy OpenAI form handler (`openai/elicitation/create`) can
 * answer on a connection with this protocol pin: a `2025-11-25` pin, or none.
 * An unpinned connection negotiates its era when it connects (a real Codex
 * client speaks only 2025 revisions). If it lands on a 2026 era there is no
 * server-to-client request at all, and the handler's `legacyClaim` withholds
 * the claim again, so nothing is promised there that the handler can't answer.
 */
export function legacyPluginFormWire(version: string | undefined): boolean {
  return version === undefined || version === "2025-11-25";
}

/** Advertise the installed request protocol, not support for every optional input. */
export function ownedLegacyFormCapabilities(
  base: Record<string, unknown>,
  handler: { binding: unknown } | undefined,
): Record<string, unknown> {
  if (!handler) return base;
  return {
    ...base,
    extensions: {
      ...(base.extensions as Record<string, unknown> | undefined),
      [OPENAI_LEGACY_FORM_EXTENSION]: { form: {} },
    },
  };
}
