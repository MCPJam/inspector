import {
  pluginInstanceKey,
  type PluginInstanceIdentity,
} from "./instance-key.js";

export const PLUGIN_OPERATION_PHASES = [
  "queued",
  "running",
  "succeeded",
  "failed",
  "cancelled",
  "unknown",
] as const;
export type PluginOperationPhase = (typeof PLUGIN_OPERATION_PHASES)[number];
export interface PluginInstance {
  id: string;
  identity: PluginInstanceIdentity;
  key: string;
  generation: number;
  lifecycle: "active" | "closed";
  visible: boolean;
  context?: {
    updateId: string;
    content: unknown[];
    structuredContent?: Record<string, unknown>;
    metadata?: Record<string, unknown>;
  };
  initialResult?: unknown;
}
export interface PluginOperation {
  id: string;
  instanceId: string;
  generation: number;
  origin:
    | PluginInstanceIdentity["origin"]["kind"]
    | "app"
    | "model"
    | "mention";
  phase: PluginOperationPhase;
  dispatched: boolean;
  activation: boolean;
  result?: unknown;
  errorCode?: string;
}
export interface PluginSessionState {
  version: 1;
  workspaceId: string;
  sequence: number;
  instances: Record<string, PluginInstance>;
  operations: Record<string, PluginOperation>;
  limits: { instances: number; operations: number };
}
export interface PluginToolTarget {
  serverId: string;
  toolName: string;
  arguments: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}
export type PluginSessionCommand =
  | {
      /** Adopt an already authorized instance without repeating its tool effect. */
      type: "attach";
      instanceId: string;
      identity: PluginInstanceIdentity;
      generation: number;
      initialResult?: unknown;
    }
  | {
      type: "activate";
      instanceId: string;
      identity: PluginInstanceIdentity;
      operationId: string;
      target: PluginToolTarget;
    }
  | {
      type: "invoke";
      instanceId: string;
      generation: number;
      operationId: string;
      origin: PluginOperation["origin"];
      target: PluginToolTarget;
    }
  | { type: "dispatched"; operationId: string; generation: number }
  | {
      type: "completed";
      operationId: string;
      generation: number;
      result: unknown;
    }
  | {
      type: "failed";
      operationId: string;
      generation: number;
      errorCode: string;
      outcomeUnknown?: boolean;
    }
  | { type: "presentation"; instanceId: string; visible: boolean }
  | {
      type: "context";
      instanceId: string;
      generation: number;
      updateId: string;
      content: unknown[];
      structuredContent?: Record<string, unknown>;
      metadata?: Record<string, unknown>;
    }
  | { type: "release-closed"; instanceId: string; generation: number }
  | { type: "replace" | "close"; instanceId: string };
// A trusted adapter may release an adopted, revoked lease with no operation
// references. It must never reuse the lease's instance ID after release.
// Invocation receipts remain bounded and cannot be erased through this seam.
export type PluginSessionEffect =
  | { type: "invoke"; operation: PluginOperation; target: PluginToolTarget }
  | { type: "cancel"; operationId: string }
  | { type: "release"; instanceId: string; generation: number };
export interface PluginTransition {
  state: PluginSessionState;
  effects: PluginSessionEffect[];
  rejection?: string;
}

export function createPluginSession(
  workspaceId: string,
  limits = { instances: 64, operations: 2048 }
): PluginSessionState {
  if (
    !workspaceId ||
    !Number.isSafeInteger(limits.instances) ||
    limits.instances < 1 ||
    limits.instances > 64 ||
    !Number.isSafeInteger(limits.operations) ||
    limits.operations < 1 ||
    limits.operations > 2048
  )
    throw new Error("Invalid plugin session limits");
  return {
    version: 1,
    workspaceId,
    sequence: 0,
    instances: Object.create(null),
    operations: Object.create(null),
    limits: { ...limits },
  };
}

const pending = (op: PluginOperation) =>
  op.phase === "queued" || op.phase === "running";
const owned = <T>(map: Record<string, T>, id: string): T | undefined =>
  Object.prototype.hasOwnProperty.call(map, id) ? map[id] : undefined;

/** Pure lifecycle and completion fencing, shared by UI and unattended execution. */
export function reducePluginSession(
  state: PluginSessionState,
  command: PluginSessionCommand
): PluginTransition {
  const unchanged = (rejection?: string): PluginTransition => ({
    state,
    effects: [],
    ...(rejection ? { rejection } : {}),
  });
  const next: PluginSessionState = {
    ...state,
    sequence: state.sequence + 1,
    instances: Object.assign(Object.create(null), state.instances),
    operations: Object.assign(Object.create(null), state.operations),
  };
  const effects: PluginSessionEffect[] = [];
  if (command.type === "release-closed") {
    const instance = owned(state.instances, command.instanceId);
    if (
      !instance ||
      instance.lifecycle !== "closed" ||
      instance.generation !== command.generation
    )
      return unchanged("STALE_INSTANCE");
    if (
      Object.values(state.operations).some(
        (operation) => operation.instanceId === instance.id
      )
    )
      return unchanged("INSTANCE_OPERATION_REFERENCES");
    delete next.instances[instance.id];
  } else if (command.type === "attach") {
    if (
      !command.instanceId ||
      !Number.isSafeInteger(command.generation) ||
      command.generation < 1
    )
      return unchanged("INVALID_ID");
    if (command.identity.workspaceId !== state.workspaceId)
      return unchanged("WORKSPACE_MISMATCH");
    let key: string;
    try {
      key = pluginInstanceKey(command.identity);
    } catch {
      return unchanged("INVALID_IDENTITY");
    }
    const previous = owned(state.instances, command.instanceId);
    if (previous)
      return previous.lifecycle === "active" &&
        previous.key === key &&
        previous.generation === command.generation
        ? unchanged()
        : unchanged("INSTANCE_MISMATCH");
    if (Object.keys(state.instances).length >= state.limits.instances)
      return unchanged("INSTANCE_LIMIT");
    if (
      Object.values(state.instances).some(
        (instance) => instance.lifecycle === "active" && instance.key === key
      )
    )
      return unchanged("INSTANCE_EXISTS");
    next.instances[command.instanceId] = {
      id: command.instanceId,
      key,
      identity: structuredClone(command.identity),
      generation: command.generation,
      lifecycle: "active",
      visible: true,
      ...(command.initialResult !== undefined
        ? { initialResult: structuredClone(command.initialResult) }
        : {}),
    };
  } else if (command.type === "activate" || command.type === "invoke") {
    // An operation ID is accepted at most once for this bounded workspace lifetime.
    if (owned(state.operations, command.operationId)) return unchanged();
    if (!command.operationId || !command.instanceId)
      return unchanged("INVALID_ID");
    if (Object.keys(state.operations).length >= state.limits.operations)
      return unchanged("OPERATION_LIMIT");
    let instance = owned(state.instances, command.instanceId);
    if (command.type === "activate") {
      if (command.identity.workspaceId !== state.workspaceId)
        return unchanged("WORKSPACE_MISMATCH");
      let key: string;
      try {
        key = pluginInstanceKey(command.identity);
      } catch {
        return unchanged("INVALID_IDENTITY");
      }
      if (instance && (instance.key !== key || instance.lifecycle === "closed"))
        return unchanged("INSTANCE_MISMATCH");
      if (!instance) {
        if (Object.keys(state.instances).length >= state.limits.instances)
          return unchanged("INSTANCE_LIMIT");
        // A second ID cannot silently create another owner for one logical instance.
        if (
          Object.values(state.instances).some(
            (candidate) =>
              candidate.key === key && candidate.lifecycle === "active"
          )
        )
          return unchanged("INSTANCE_EXISTS");
        instance = {
          id: command.instanceId,
          identity: structuredClone(command.identity),
          key,
          generation: 1,
          lifecycle: "active",
          visible: true,
        };
        next.instances[instance.id] = instance;
      }
    } else if (
      !instance ||
      instance.lifecycle !== "active" ||
      instance.generation !== command.generation
    )
      return unchanged("STALE_INSTANCE");
    if (
      !instance ||
      command.target.serverId !== instance.identity.serverId ||
      !command.target.toolName
    )
      return unchanged("TARGET_MISMATCH");
    const operation: PluginOperation = {
      id: command.operationId,
      instanceId: instance.id,
      generation: instance.generation,
      origin:
        command.type === "activate"
          ? instance.identity.origin.kind
          : command.origin,
      phase: "queued",
      dispatched: false,
      activation: command.type === "activate",
    };
    next.operations[operation.id] = operation;
    effects.push({
      type: "invoke",
      operation,
      target: structuredClone(command.target),
    });
  } else if (
    command.type === "dispatched" ||
    command.type === "completed" ||
    command.type === "failed"
  ) {
    const operation = owned(state.operations, command.operationId);
    const instance = operation && owned(state.instances, operation.instanceId);
    if (
      !operation ||
      !pending(operation) ||
      operation.generation !== command.generation ||
      instance?.generation !== command.generation ||
      instance.lifecycle !== "active"
    )
      return unchanged();
    if (command.type === "dispatched") {
      if (operation.dispatched) return unchanged();
      next.operations[operation.id] = {
        ...operation,
        phase: "running",
        dispatched: true,
      };
    } else if (command.type === "completed") {
      next.operations[operation.id] = {
        ...operation,
        phase: "succeeded",
        result: structuredClone(command.result),
      };
      if (operation.activation && instance.initialResult === undefined)
        next.instances[instance.id] = {
          ...instance,
          initialResult: structuredClone(command.result),
        };
    } else
      next.operations[operation.id] = {
        ...operation,
        phase: command.outcomeUnknown ? "unknown" : "failed",
        errorCode: command.errorCode,
      };
  } else {
    const instance = owned(state.instances, command.instanceId);
    if (!instance || instance.lifecycle !== "active")
      return unchanged("STALE_INSTANCE");
    if (command.type === "presentation")
      next.instances[instance.id] = { ...instance, visible: command.visible };
    else if (command.type === "context") {
      if (command.generation !== instance.generation)
        return unchanged("STALE_INSTANCE");
      next.instances[instance.id] = {
        ...instance,
        context: {
          updateId: command.updateId,
          content: structuredClone(command.content),
          ...(command.structuredContent
            ? { structuredContent: structuredClone(command.structuredContent) }
            : {}),
          ...(command.metadata
            ? { metadata: structuredClone(command.metadata) }
            : {}),
        },
      };
    } else {
      next.instances[instance.id] = {
        ...instance,
        generation: instance.generation + 1,
        lifecycle: command.type === "close" ? "closed" : "active",
        visible: command.type !== "close" && instance.visible,
        context: undefined,
        initialResult: undefined,
      };
      for (const operation of Object.values(state.operations)) {
        if (operation.instanceId !== instance.id || !pending(operation))
          continue;
        next.operations[operation.id] = {
          ...operation,
          phase: operation.dispatched ? "unknown" : "cancelled",
        };
        effects.push({ type: "cancel", operationId: operation.id });
      }
      effects.push({
        type: "release",
        instanceId: instance.id,
        generation: instance.generation,
      });
    }
  }
  return { state: next, effects };
}

/** Hidden apps contribute context only to their own global/thread scope. */
export function pluginContextForTurn(
  state: PluginSessionState,
  threadId: string
) {
  return Object.values(state.instances)
    .filter(
      (instance) =>
        instance.lifecycle === "active" &&
        instance.context &&
        (instance.identity.scope.kind === "global" ||
          instance.identity.scope.threadId === threadId)
    )
    .map((instance) => ({
      instanceId: instance.id,
      generation: instance.generation,
      ...structuredClone(instance.context!),
    }));
}
