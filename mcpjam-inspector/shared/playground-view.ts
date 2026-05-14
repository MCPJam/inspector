import { z } from "zod";

/**
 * Playground view payloads are persisted opaquely (`v.any()`) in Convex.
 * The shape evolves over time; `payloadVersion` selects which Zod schema
 * to validate against. Adding a field is a new minor schema update;
 * removing/renaming a field requires a new `payloadVersion`.
 *
 * v2: drops the `layout` object. The IDE-style sortable-pane system was
 * replaced with the chat-v2 fixed-rail layout (collapsible left/right
 * panels driven by local React state, not persisted per view). Any
 * persisted v1 rows are accepted and forward-migrated by stripping
 * `layout` — see `parsePlaygroundViewPayload`.
 */

const ServerToolRefSchema = z.object({
  serverId: z.string(),
  toolName: z.string(),
});

const CustomViewportSchema = z.object({
  width: z.number(),
  height: z.number(),
});

const DeviceTypeSchema = z.enum(["mobile", "tablet", "desktop", "custom"]);
const DisplayModeSchema = z.enum(["inline", "pip", "fullscreen"]);
const UITypeSchema = z.enum([
  "mcp-apps",
  "openai-sdk",
  "openai-sdk-and-mcp-apps",
  "mcp-ui",
]);
const TraceViewModeSchema = z.enum(["chat", "timeline", "raw"]);

export const PlaygroundViewPayloadV2Schema = z.object({
  servers: z.object({
    selectedServerNames: z.array(z.string()),
    hostId: z.string().optional(),
  }),
  tools: z.object({
    selectedTool: ServerToolRefSchema.optional(),
    formValues: z.record(z.string(), z.unknown()).optional(),
    selectedProtocol: UITypeSchema.optional(),
    deviceType: DeviceTypeSchema,
    customViewport: CustomViewportSchema.optional(),
    displayMode: DisplayModeSchema,
  }),
  chat: z.object({
    enableMultiModelChat: z.boolean(),
    traceViewMode: TraceViewModeSchema,
    isJsonRpcPanelVisible: z.boolean(),
  }),
});

export type PlaygroundViewPayloadV2 = z.infer<
  typeof PlaygroundViewPayloadV2Schema
>;

// Public alias — consumers reference the latest version through `V1`-style
// naming. Keeping the alias avoids a churn-y rename across the inspector.
export type PlaygroundViewPayloadV1 = PlaygroundViewPayloadV2;
export const PlaygroundViewPayloadV1Schema = PlaygroundViewPayloadV2Schema;

export const PLAYGROUND_VIEW_PAYLOAD_VERSION = 2 as const;

/**
 * Default scratch workspace shown on first open — chat-v2-style fixed rails
 * (Sessions/Tools on the left, optional logger on the right). Collapse state
 * is local React state and not persisted per view in v2.
 */
export const DEFAULT_PLAYGROUND_PAYLOAD: PlaygroundViewPayloadV2 = {
  servers: {
    selectedServerNames: [],
  },
  tools: {
    deviceType: "desktop",
    displayMode: "inline",
  },
  chat: {
    // Default-on so the flag-on Playground matches today's App Builder UX
    // (which is mounted with `enableMultiModelChat` from App.tsx). Users can
    // toggle it off in the model selector ("Multiple models").
    enableMultiModelChat: true,
    traceViewMode: "chat",
    isJsonRpcPanelVisible: false,
  },
};

export function parsePlaygroundViewPayload(
  payloadVersion: number,
  payload: unknown,
): PlaygroundViewPayloadV2 | null {
  if (payloadVersion === PLAYGROUND_VIEW_PAYLOAD_VERSION) {
    const result = PlaygroundViewPayloadV2Schema.safeParse(payload);
    return result.success ? result.data : null;
  }
  if (payloadVersion === 1) {
    // Forward-migrate v1 → v2 by stripping `layout`. The remaining keys
    // already match v2 shape.
    if (typeof payload !== "object" || payload === null) return null;
    const { layout: _ignored, ...rest } = payload as Record<string, unknown>;
    const result = PlaygroundViewPayloadV2Schema.safeParse(rest);
    return result.success ? result.data : null;
  }
  return null;
}
