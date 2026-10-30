import type { ConvexHttpClient } from "convex/browser";
import type { InternalExecutionTarget } from "../../../shared/execution-target.js";
import {
  resolveEnvironmentForRuntime,
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
  const composition =
    args.target.kind === "environment"
      ? null
      : await composeTurnEnvironment({
          client: args.client,
          projectId: args.access.projectId,
          ...(args.target.kind === "host"
            ? { hostId: args.target.hostId }
            : {}),
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
