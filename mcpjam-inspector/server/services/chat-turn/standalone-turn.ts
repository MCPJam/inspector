import type { Context } from "hono";
import type { ChatV2Request } from "@/shared/chat-v2";
import { HOSTED_MODE, WEBMCP_INSPECTOR_ENABLED } from "../../config.js";
import { ErrorCode, WebRouteError } from "../../routes/web/errors.js";
import { resolveExecutionContext } from "../../utils/host-execution-context.js";
import {
  resolveChatSelection,
  withSelectionRouting,
  decideTurnRail,
} from "../../utils/selection-rail.js";
import {
  parseChatReasoningEffort,
  resolveChatReasoningEffort,
} from "../../utils/chat-reasoning-effort.js";
import { listLocalRuntimeSkills } from "../../utils/skill-tools.js";
import { buildLiveEffectiveCapabilities } from "../environments/effective-capabilities.js";
import {
  validateAppToolEntries,
  validatePageToolEntries,
  validateWidgetModelContextEntries,
} from "../../utils/chat-v2-orchestration.js";
import { getProductionGuestAuthHeader } from "../../utils/guest-auth.js";
import { getSpendClientIp } from "../../utils/client-ip.js";
import { streamChatTurn } from "../../utils/web-chat-turn.js";
import {
  parseScopeStepUpResumeRequest,
  parseScopeStepUpCancelRequest,
} from "@/shared/scope-step-up";
import { logger } from "../../utils/logger.js";

/** Existing local callers with no managed project or saved target. */
export async function runStandaloneTurn(
  c: Context,
  body: ChatV2Request & { hostId?: unknown; scenarioId?: unknown },
): Promise<Response> {
  if (
    HOSTED_MODE ||
    body.projectId ||
    body.executionTarget ||
    body.hostId ||
    body.scenarioId
  ) {
    throw new WebRouteError(
      403,
      ErrorCode.FORBIDDEN,
      "Managed turns require managed setup.",
    );
  }
  if (!Array.isArray(body.messages) || !body.messages.length) {
    throw new WebRouteError(
      400,
      ErrorCode.VALIDATION_ERROR,
      "messages are required",
    );
  }
  if (!body.model?.id)
    throw new WebRouteError(
      400,
      ErrorCode.VALIDATION_ERROR,
      "model is not supported",
    );
  const serverNames = body.selectedServers ?? [];
  if (
    !Array.isArray(serverNames) ||
    serverNames.some((name) => typeof name !== "string" || !name)
  ) {
    throw new WebRouteError(
      400,
      ErrorCode.VALIDATION_ERROR,
      "selectedServers must contain server names",
    );
  }
  const resumeRequest = parseScopeStepUpResumeRequest(body.scopeStepUpResume);
  const cancelRequest = parseScopeStepUpCancelRequest(body.scopeStepUpCancel);
  if (
    (body.scopeStepUpResume !== undefined && !resumeRequest) ||
    (body.scopeStepUpCancel !== undefined && !cancelRequest) ||
    (resumeRequest && cancelRequest)
  ) {
    throw new WebRouteError(
      400,
      ErrorCode.VALIDATION_ERROR,
      "Invalid scope step-up action",
    );
  }
  const selected = resolveChatSelection({
    raw: body.modelSelection,
    model: body.model,
    hostWins: false,
    allowLocal: true,
  });
  if (!selected.ok)
    throw new WebRouteError(400, ErrorCode.VALIDATION_ERROR, selected.error);
  const model = withSelectionRouting(body.model, selected.selection);
  const rail = decideTurnRail({ selection: selected.selection, model });
  if (rail === "org") {
    throw new WebRouteError(
      400,
      ErrorCode.VALIDATION_ERROR,
      "This organization model requires a project.",
    );
  }
  if (rail === "hosted" && !process.env.CONVEX_HTTP_URL) {
    throw new WebRouteError(
      500,
      ErrorCode.INTERNAL_ERROR,
      "Server missing CONVEX_HTTP_URL configuration",
    );
  }
  const effort = parseChatReasoningEffort(body.reasoningEffort);
  if (!effort.ok)
    throw new WebRouteError(400, ErrorCode.VALIDATION_ERROR, effort.error);
  const reasoningEffort = resolveChatReasoningEffort({
    bodyEffort: effort.effort,
    requestSelection: selected.requestSelection,
    hostSelection:
      selected.selection?.source === "legacy" ? undefined : selected.selection,
    hostWins: false,
  });
  const execution = resolveExecutionContext({
    hostConfig: null,
    precedence: "override-wins",
    overrides: {
      systemPrompt: body.systemPrompt,
      temperature: body.temperature,
      requireToolApproval: body.requireToolApproval,
      respectToolVisibility: body.respectToolVisibility,
      progressiveToolDiscovery: body.progressiveToolDiscovery,
      modelVisibleMcpToolResults: body.modelVisibleMcpToolResults,
      mcpToolResultImageRendering: body.mcpToolResultImageRendering,
      hostStyle: body.hostStyle ?? "claude",
    },
  });
  const localSkills = await listLocalRuntimeSkills().catch((error) => {
    logger.warn("[chat-v2] local skill scan failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    return [];
  });
  const authHeader =
    c.req.header("authorization") ??
    (rail === "hosted"
      ? ((await getProductionGuestAuthHeader()) ?? undefined)
      : undefined);
  if (rail === "hosted" && !authHeader) {
    throw new WebRouteError(
      503,
      ErrorCode.UNAUTHORIZED,
      "Unable to authenticate this chat. Try again or sign in.",
    );
  }
  // A stable identity, never the bearer: a token refreshed between suspend and
  // resume must still find its continuation (the legacy route's key).
  const principal =
    c.get("workosUserId") ??
    c.get("guestId") ??
    c.var.requestLogContext?.userId ??
    "local-anonymous";
  return streamChatTurn(
    {
      manager: c.mcpClientManager,
      prepare: {
        selectedServerIds: serverNames,
        modelDefinition: model,
        routingSelection: selected.selection,
        routingSelectionOrigin: selected.origin,
        uiMessages: body.messages,
        systemPrompt: execution.systemPrompt,
        temperature: body.temperature ?? execution.temperature,
        reasoningEffort,
        explicitTemperature: effort.effort ? body.temperature : undefined,
        requireToolApproval: execution.requireToolApproval,
        respectToolVisibility: execution.respectToolVisibility,
        modelVisibleMcpToolResults: execution.modelVisibleMcpToolResults,
        customProviders: body.customProviders,
        ...(rail !== "hosted"
          ? {
              directProvider: {
                apiKey: body.apiKey,
                baseUrls: {
                  ollama: body.ollamaBaseUrl,
                  azure: body.azureBaseUrl,
                },
                customProviders: body.customProviders,
              },
            }
          : {}),
        appTools: validateAppToolEntries(body.appTools),
        pageTools: WEBMCP_INSPECTOR_ENABLED
          ? validatePageToolEntries(body.pageTools)
          : [],
        widgetModelContext: validateWidgetModelContextEntries(
          body.widgetModelContext,
        ),
        liveSkillSurface: true,
        effectiveCapabilities: buildLiveEffectiveCapabilities({ localSkills }),
        ...(execution.progressiveToolDiscovery !== undefined
          ? {
              progressiveToolDiscovery: {
                enabled: execution.progressiveToolDiscovery,
              },
            }
          : {}),
      },
      persist: {
        projectId: "",
        chatSessionId: body.chatSessionId,
        sourceType: "direct",
        origin: "playground",
        originalMessages: body.messages,
        selectedServerIds: serverNames,
        selectedServerNames: serverNames,
        systemPrompt: execution.systemPrompt,
        temperature: body.temperature ?? execution.temperature,
        requireToolApproval: execution.requireToolApproval,
        respectToolVisibility: execution.respectToolVisibility,
        mcpToolResultImageRendering: execution.mcpToolResultImageRendering,
        directVisibility: body.directVisibility,
        expectedVersion: body.expectedVersion,
        rewind: body.rewind,
        runtimeSecrets: [],
      },
      runtime: {
        c,
        authHeader,
        clientIp: getSpendClientIp(c),
        abortSignal: c.req.raw.signal,
        // The standalone debugger owns this manager beyond the current turn.
        dispose: async () => undefined,
        localScopeStepUp: {
          bindingKey: JSON.stringify([
            process.env.CONVEX_HTTP_URL ?? "",
            principal,
            body.chatSessionId ?? "",
          ]),
          resumeRequest: resumeRequest ?? undefined,
          cancelRequest: cancelRequest ?? undefined,
        },
      },
    },
    "standalone",
  );
}
