/**
 * Recording is inert evidence, never an execution lease. IDs are separately
 * minted by the recorder; no tokens, targets, arguments, results, paths, URLs,
 * context, settings or app-authored metadata belong in this DTO. The image is
 * held by the enclosing browser artifact's existing owned screenshot claim.
 *
 * Mirrored byte-for-byte (modulo formatting) in the backend, with a mirror pin.
 * Keep this module framework/browser/Convex independent.
 */
export const PLUGIN_RECORDING_EVENT_LIMIT = 128;
export const PLUGIN_RECORDING_INSTANCE_LIMIT = 64;
export const PLUGIN_RECORDING_KINDS = [
  "opened",
  "selected",
  "shown",
  "hidden",
  "closed",
  "call-started",
  "call-completed",
  "call-denied",
  "call-unknown",
  "call-suspended",
  "call-continued",
  "cancel-requested",
] as const;
export type PluginRecordingEventKind = (typeof PLUGIN_RECORDING_KINDS)[number];
export type PluginWorkspaceRecordingV1 = {
  version: 1;
  runtime: "chatgpt" | "codex";
  sequence: number;
  droppedEvents: number;
  activeInstanceId?: string;
  instances: Array<{
    instanceId: string;
    generation: number;
    visible: boolean;
  }>;
  events: Array<{
    sequence: number;
    kind: PluginRecordingEventKind;
    instanceId: string;
    generation: number;
    operationId?: string;
  }>;
};

/** Feature evidence is a closed host vocabulary, never an app-authored label. */
export const PLUGIN_RECORDING_FEATURES = [
  "model-tool",
  "app-tool",
  "preview-tool",
  "entrypoint",
  "global-entrypoint",
  "thread-entrypoint",
  "settings-entrypoint",
  "quick-action",
  "file-entrypoint",
  "settings-read",
  "settings-update",
  "settings-action",
  "mention-search",
  "model-context",
  "context-removal",
  "file-open",
  "file-read",
  "file-write",
  "file-subscribe",
  "file-unsubscribe",
  "form-mrtr",
  "form-legacy",
  "resource-preview",
  "app-preview",
  "deep-link",
  "message",
  "message-prepare",
  "app-display",
] as const;
export type PluginRecordingFeature = (typeof PLUGIN_RECORDING_FEATURES)[number];
export type PluginRecordingSemantic = {
  feature: PluginRecordingFeature;
  /** Observed host behavior is not a claim of complete runtime conformance. */
  fidelity: "observed" | "assumed" | "degraded";
  outcome?: "saved" | "conflict" | "too-large";
  /** Closed host presentation state, never app text, paths or live handles. */
  display?: {
    availableDisplayModes: ("inline" | "fullscreen")[];
    displayMode?: "inline" | "fullscreen";
    interactionCursor: "pointer" | "default";
  };
};
export type PluginWorkspaceRecordingV2 = Omit<
  PluginWorkspaceRecordingV1,
  "version" | "events"
> & {
  version: 2;
  events: Array<
    PluginWorkspaceRecordingV1["events"][number] &
      Partial<PluginRecordingSemantic>
  >;
};
export type PluginWorkspaceRecording =
  PluginWorkspaceRecordingV1 | PluginWorkspaceRecordingV2;

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const integer = (value: unknown, minimum = 0): value is number =>
  Number.isSafeInteger(value) && (value as number) >= minimum;
function record(
  value: unknown,
  keys: readonly string[],
): value is Record<string, unknown> {
  return (
    !!value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).every((key) => keys.includes(key))
  );
}
const id = (value: unknown): value is string =>
  typeof value === "string" && uuid.test(value);

/** Unknown versions/events or extra fields reject ONLY this capture on read. */
export function parsePluginWorkspaceRecording(
  value: unknown,
): PluginWorkspaceRecording {
  if (
    !record(value, [
      "version",
      "runtime",
      "sequence",
      "droppedEvents",
      "activeInstanceId",
      "instances",
      "events",
    ]) ||
    (value.version !== 1 && value.version !== 2) ||
    !["chatgpt", "codex"].includes(value.runtime as string) ||
    !integer(value.sequence) ||
    !integer(value.droppedEvents) ||
    value.droppedEvents > value.sequence ||
    !Array.isArray(value.instances) ||
    value.instances.length > PLUGIN_RECORDING_INSTANCE_LIMIT ||
    !Array.isArray(value.events) ||
    value.events.length > PLUGIN_RECORDING_EVENT_LIMIT
  )
    throw new Error("PLUGIN_RECORDING_INVALID");
  const seen = new Set<string>();
  for (const item of value.instances) {
    if (
      !record(item, ["instanceId", "generation", "visible"]) ||
      !id(item.instanceId) ||
      seen.has(item.instanceId) ||
      !integer(item.generation, 1) ||
      typeof item.visible !== "boolean"
    )
      throw new Error("PLUGIN_RECORDING_INVALID");
    seen.add(item.instanceId);
  }
  if (
    value.activeInstanceId !== undefined &&
    (!id(value.activeInstanceId) ||
      !value.instances.some(
        (item) => item.instanceId === value.activeInstanceId && item.visible,
      ))
  )
    throw new Error("PLUGIN_RECORDING_INVALID");
  let previous = value.droppedEvents;
  for (const event of value.events) {
    if (
      !record(event, [
        "sequence",
        "kind",
        "instanceId",
        "generation",
        "operationId",
        ...(value.version === 2
          ? ["feature", "fidelity", "outcome", "display"]
          : []),
      ]) ||
      !integer(event.sequence, 1) ||
      event.sequence !== previous + 1 ||
      event.sequence > value.sequence ||
      !(PLUGIN_RECORDING_KINDS as readonly unknown[]).includes(event.kind) ||
      !id(event.instanceId) ||
      !integer(event.generation, 1)
    )
      throw new Error("PLUGIN_RECORDING_INVALID");
    const operation =
      (event.kind as string).startsWith("call-") ||
      event.kind === "cancel-requested";
    if (operation ? !id(event.operationId) : event.operationId !== undefined)
      throw new Error("PLUGIN_RECORDING_INVALID");
    if (
      (event.feature === undefined) !== (event.fidelity === undefined) ||
      (event.feature !== undefined &&
        (!operation ||
          !(PLUGIN_RECORDING_FEATURES as readonly unknown[]).includes(
            event.feature,
          ) ||
          !["observed", "assumed", "degraded"].includes(
            event.fidelity as string,
          )))
    )
      throw new Error("PLUGIN_RECORDING_INVALID");
    if (
      event.outcome !== undefined &&
      (event.feature !== "file-write" ||
        event.kind !== "call-completed" ||
        !["saved", "conflict", "too-large"].includes(event.outcome as string))
    )
      throw new Error("PLUGIN_RECORDING_INVALID");
    if (event.display !== undefined) {
      const display = event.display;
      if (
        event.feature !== "app-display" ||
        event.kind !== "call-completed" ||
        !record(display, [
          "availableDisplayModes",
          "displayMode",
          "interactionCursor",
        ]) ||
        !Array.isArray(display.availableDisplayModes) ||
        display.availableDisplayModes.length > 2 ||
        new Set(display.availableDisplayModes).size !==
          display.availableDisplayModes.length ||
        !display.availableDisplayModes.every(
          (mode) => mode === "inline" || mode === "fullscreen",
        ) ||
        (display.availableDisplayModes.length === 0
          ? display.displayMode !== undefined
          : !display.availableDisplayModes.includes(display.displayMode)) ||
        !["pointer", "default"].includes(display.interactionCursor as string)
      )
        throw new Error("PLUGIN_RECORDING_INVALID");
    }
    previous = event.sequence;
  }
  if (previous !== value.sequence) throw new Error("PLUGIN_RECORDING_INVALID");
  // Prevent a live mutable object from becoming replay state after validation.
  return JSON.parse(JSON.stringify(value)) as PluginWorkspaceRecording;
}
