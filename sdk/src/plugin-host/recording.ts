import { z } from "zod";
import {
  PLUGIN_OPERATION_PHASES,
  type PluginSessionState,
  type PluginOperationPhase,
} from "./session.js";

/** Safe default projection: no wire payloads, settings, private paths or file bytes. */
export interface PluginWorkspaceCheckpointV1 {
  version: 1;
  sequence: number;
  instances: Array<{
    id: string;
    generation: number;
    lifecycle: "active" | "closed";
    visible: boolean;
  }>;
  operations: Array<{
    id: string;
    instanceId: string;
    generation: number;
    phase: PluginOperationPhase;
  }>;
}

const id = z.string().min(1).max(4096);
const checkpointSchema = z
  .strictObject({
    version: z.literal(1),
    sequence: z.number().int().nonnegative(),
    instances: z
      .array(
        z.strictObject({
          id,
          generation: z.number().int().positive(),
          lifecycle: z.enum(["active", "closed"]),
          visible: z.boolean(),
        })
      )
      .max(64),
    operations: z
      .array(
        z.strictObject({
          id,
          instanceId: id,
          generation: z.number().int().positive(),
          phase: z.enum(PLUGIN_OPERATION_PHASES),
        })
      )
      .max(2048),
  })
  .superRefine((checkpoint, ctx) => {
    const instances = new Map(
      checkpoint.instances.map((instance) => [instance.id, instance])
    );
    if (
      instances.size !== checkpoint.instances.length ||
      new Set(checkpoint.operations.map((operation) => operation.id)).size !==
        checkpoint.operations.length ||
      checkpoint.operations.some(
        (operation) =>
          !instances.has(operation.instanceId) ||
          operation.generation > instances.get(operation.instanceId)!.generation
      )
    ) {
      ctx.addIssue({
        code: "custom",
        message: "Invalid workspace checkpoint identities",
      });
    }
  });

export function parsePluginWorkspaceCheckpoint(
  value: unknown
): PluginWorkspaceCheckpointV1 {
  return checkpointSchema.parse(value);
}
export function pluginWorkspaceCheckpoint(
  state: PluginSessionState
): PluginWorkspaceCheckpointV1 {
  return {
    version: 1,
    sequence: state.sequence,
    instances: Object.values(state.instances).map(
      ({ id, generation, lifecycle, visible }) => ({
        id,
        generation,
        lifecycle,
        visible,
      })
    ),
    operations: Object.values(state.operations).map(
      ({ id, instanceId, generation, phase }) => ({
        id,
        instanceId,
        generation,
        phase,
      })
    ),
  };
}

/** Data-only replay with no runner, services, plugin JavaScript or network hooks. */
export function createPluginWorkspaceReplay(checkpoint: unknown) {
  const snapshot = parsePluginWorkspaceCheckpoint(checkpoint);
  return { getSnapshot: () => structuredClone(snapshot) };
}
