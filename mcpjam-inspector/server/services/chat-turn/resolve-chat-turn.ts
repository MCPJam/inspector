import { externalAccountCredentialFor } from "../../../shared/external-credential-selection.js";
import { markOnboardingPhase } from "../plugin-host/onboarding-trace.js";
import { makeFunctionReference } from "convex/server";
import { isRecord } from "../../utils/byok/list-request.js";
import {
  normalizeHostRuntimeConfig,
  type HostRuntimeConfig,
} from "../../utils/host-runtime-config.js";
import type { ConvexHttpClient } from "convex/browser";
import type { InternalExecutionTarget } from "../../../shared/execution-target.js";
import {
  resolveEnvironmentForRuntime,
  assertRuntimeInvariants,
  resolveRuntimeVenue,
  translateEnvironmentRuntimeError,
  type ResolvedEnvironmentRuntime,
} from "../environments/runtime.js";
import { composeTurnEnvironment } from "./compose-turn-environment.js";
import { ErrorCode, WebRouteError } from "../../routes/web/errors.js";

export type TurnServerSelection =
  | { kind: "environment-default" }
  | { kind: "client-default" }
  | { kind: "explicit"; serverIds: string[] };

export type TurnAccess = { kind: "project"; projectId: string };

export type ResolvedChatTurn = {
  kind: "project";
  mode: "interactive";
  access: TurnAccess;
  environment: ResolvedEnvironmentRuntime;
  composed: boolean;
  selection: TurnServerSelection;
};

/** Authenticated adapters supply access intent; the existing resolvers authorize it live. */
export async function resolveChatTurn(args: {
  target: Exclude<InternalExecutionTarget, { kind: "scenario" }>;
  access: TurnAccess;
  selection: TurnServerSelection;
  client?: ConvexHttpClient;
  bearer: string;
  signal?: AbortSignal;
  prepareChatTurn?: boolean;
}): Promise<ResolvedChatTurn> {
  if (
    !args.client ||
    (args.target.kind === "adhoc" &&
      args.target.projectId !== args.access.projectId)
  ) {
    throw new WebRouteError(
      403,
      ErrorCode.FORBIDDEN,
      "The project does not match this turn's access.",
    );
  }
  const composed = args.target.kind !== "environment";
  let preparedHost: { hostId: string; config: HostRuntimeConfig } | undefined;
  if (args.prepareChatTurn && composed) {
    let raw: unknown;
    try {
      raw = await args.client.action(
        makeFunctionReference<"action">("chatTurnPreparation:prepareChatTurn"),
        {
          projectId: args.access.projectId,
          ...(args.target.kind === "host"
            ? { hostId: args.target.hostId }
            : {}),
          ...(args.selection.kind === "explicit"
            ? { serverOverrideIds: args.selection.serverIds }
            : {}),
          ...(args.selection.kind === "client-default"
            ? { serverSelectionSource: "client-default" }
            : {}),
          ...(resolveRuntimeVenue()
            ? { runtimeVenue: resolveRuntimeVenue() }
            : {}),
        },
      );
    } catch (error) {
      if (args.signal?.aborted) throw error;
      if (error instanceof Error && error.name === "TimeoutError") {
        throw new WebRouteError(
          504,
          ErrorCode.SERVER_UNREACHABLE,
          "Chat preparation timed out. Try sending your message again.",
        );
      }
      throw translateEnvironmentRuntimeError(error);
    }
    if (isRecord(raw) && raw.kind === "resolved") {
      const environment = assertRuntimeInvariants(raw.environment);
      if (
        args.target.kind === "host" &&
        environment.host.hostId !== args.target.hostId
      ) {
        throw new WebRouteError(
          502,
          ErrorCode.INTERNAL_ERROR,
          "Couldn't prepare this client. Try sending your message again.",
        );
      }
      if (
        (environment.host.runtimeConfig.agentLoop ??
          environment.host.runtimeConfig.harness ??
          null) !== raw.harness
      ) {
        throw new WebRouteError(
          409,
          ErrorCode.CONFLICT,
          "The client's runtime changed while preparing this turn. Send again to use its current settings.",
        );
      }
      markOnboardingPhase("admission");
      return {
        kind: "project",
        mode: "interactive",
        access: args.access,
        environment,
        composed,
        selection: args.selection,
      };
    }
    if (
      !isRecord(raw) ||
      raw.kind !== "external-account" ||
      typeof raw.hostId !== "string" ||
      !isRecord(raw.runtimeConfig)
    ) {
      throw new WebRouteError(
        502,
        ErrorCode.INTERNAL_ERROR,
        "Couldn't prepare this chat. Try sending your message again.",
      );
    }
    const harness = raw.runtimeConfig.agentLoop ?? raw.runtimeConfig.harness;
    if (
      typeof harness !== "string" ||
      !externalAccountCredentialFor(harness) ||
      (args.target.kind === "host" && raw.hostId !== args.target.hostId)
    ) {
      throw new WebRouteError(
        502,
        ErrorCode.INTERNAL_ERROR,
        "Couldn't prepare this client. Try sending your message again.",
      );
    }
    preparedHost = {
      hostId: raw.hostId,
      config: normalizeHostRuntimeConfig(raw.runtimeConfig),
    };
  }
  const composition =
    args.target.kind === "environment"
      ? null
      : await composeTurnEnvironment({
          client: args.client,
          projectId: args.access.projectId,
          ...(args.target.kind === "host"
            ? { hostId: args.target.hostId }
            : {}),
          ...(preparedHost ? { preparedHost } : {}),
          bearer: args.bearer,
          signal: args.signal,
        });
  const environmentId =
    args.target.kind === "environment"
      ? args.target.environmentId
      : composition!.environmentId;
  const environment = await resolveEnvironmentForRuntime(args.client, {
    projectId: args.access.projectId,
    environmentId,
    ...(args.selection.kind === "client-default"
      ? { serverSelectionSource: "client-default" as const }
      : {}),
    ...(args.selection.kind === "explicit"
      ? { overrides: { serverIds: args.selection.serverIds } }
      : {}),
  });
  if (
    composition &&
    (environment.host.runtimeConfig.agentLoop ??
      environment.host.runtimeConfig.harness ??
      null) !== composition.harness
  ) {
    throw new WebRouteError(
      409,
      ErrorCode.CONFLICT,
      "The client's runtime changed while preparing this turn. Send again to use its current settings.",
    );
  }
  return {
    kind: "project",
    mode: "interactive",
    access: args.access,
    environment,
    composed,
    selection: args.selection,
  };
}