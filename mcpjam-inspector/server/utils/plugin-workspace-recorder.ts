import { randomUUID } from "node:crypto";
import {
  PLUGIN_RECORDING_EVENT_LIMIT,
  PLUGIN_RECORDING_INSTANCE_LIMIT,
  type PluginWorkspaceRecordingV2,
} from "../../shared/plugin-workspace-recording.js";

type Instance = PluginWorkspaceRecordingV2["instances"][number];
type Event = PluginWorkspaceRecordingV2["events"][number];

/** Host observations only. Private routing keys never enter the recording. */
export class PluginWorkspaceRecorder {
  private readonly instances = new Map<string, Instance>();
  private readonly events: Event[] = [];
  private sequence = 0;
  private droppedEvents = 0;

  private append(
    instance: Instance,
    kind: Event["kind"],
    operationId?: string,
  ) {
    this.events.push({
      sequence: ++this.sequence,
      kind,
      instanceId: instance.instanceId,
      generation: instance.generation,
      ...(operationId
        ? {
            operationId,
            feature: "app-tool" as const,
            fidelity: "observed" as const,
          }
        : {}),
    });
    if (this.events.length > PLUGIN_RECORDING_EVENT_LIMIT) {
      this.events.shift();
      this.droppedEvents++;
    }
  }

  open(key: string) {
    if (this.instances.has(key)) return;
    if (this.instances.size >= PLUGIN_RECORDING_INSTANCE_LIMIT) {
      const closed = [...this.instances].find(([, value]) => !value.visible);
      if (!closed) return;
      this.instances.delete(closed[0]);
    }
    const instance = { instanceId: randomUUID(), generation: 1, visible: true };
    this.instances.set(key, instance);
    this.append(instance, "opened");
    this.append(instance, "shown");
  }

  close(key: string) {
    const instance = this.instances.get(key);
    if (!instance?.visible) return;
    instance.visible = false;
    this.append(instance, "hidden");
    this.append(instance, "closed");
  }

  beginCall(key: string) {
    const instance = this.instances.get(key);
    if (!instance?.visible) return () => {};
    const operationId = randomUUID();
    this.append(instance, "call-started", operationId);
    let settled = false;
    return (success: boolean) => {
      if (settled) return;
      settled = true;
      this.append(
        instance,
        success ? "call-completed" : "call-unknown",
        operationId,
      );
    };
  }

  snapshot(runtime: unknown): PluginWorkspaceRecordingV2 | undefined {
    // An arbitrary host style is not evidence of either supported runtime.
    if (runtime !== "chatgpt" && runtime !== "codex") return undefined;
    const instances = [...this.instances.values()].map((value) => ({
      ...value,
    }));
    const active = instances.find((value) => value.visible);
    return {
      version: 2,
      runtime,
      sequence: this.sequence,
      droppedEvents: this.droppedEvents,
      ...(active ? { activeInstanceId: active.instanceId } : {}),
      instances,
      events: this.events.map((value) => ({ ...value })),
    };
  }
}
