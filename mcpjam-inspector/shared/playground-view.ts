import { z } from "zod";

/**
 * Playground view payloads are persisted opaquely (`v.any()`) in Convex.
 * The shape evolves over time; `payloadVersion` selects which Zod schema
 * to validate against. Adding a field is a new minor schema update;
 * removing/renaming a field requires a new `payloadVersion`.
 */

export const PANE_IDS = ["tools", "chatHistory", "header"] as const;
export type PaneId = (typeof PANE_IDS)[number];

const PaneIdSchema = z.enum(PANE_IDS);

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

export const PlaygroundViewLayoutV1Schema = z.object({
  leftPanes: z.array(PaneIdSchema),
  rightPanes: z.array(PaneIdSchema),
  leftWidth: z.number(),
  rightWidth: z.number(),
  centerPane: z.literal("thread"),
});

export const PlaygroundViewPayloadV1Schema = z.object({
  layout: PlaygroundViewLayoutV1Schema,
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

export type PlaygroundViewLayoutV1 = z.infer<
  typeof PlaygroundViewLayoutV1Schema
>;
export type PlaygroundViewPayloadV1 = z.infer<
  typeof PlaygroundViewPayloadV1Schema
>;

export const PLAYGROUND_VIEW_PAYLOAD_VERSION = 1 as const;

/**
 * Default scratch workspace shown on first open — matches today's App Builder
 * layout (tools rail left, chat thread center). The docked `tools` pane
 * renders the legacy `PlaygroundLeft` via `AppBuilderStateContext`, so the
 * playground center is a clean `<PlaygroundMain/>` without an embedded tools
 * sidebar of its own.
 */
export const DEFAULT_PLAYGROUND_PAYLOAD: PlaygroundViewPayloadV1 = {
  layout: {
    leftPanes: ["tools"],
    rightPanes: [],
    leftWidth: 30,
    rightWidth: 0,
    centerPane: "thread",
  },
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
    // toggle it off in the PlaygroundHeader.
    enableMultiModelChat: true,
    traceViewMode: "chat",
    isJsonRpcPanelVisible: false,
  },
};

export function parsePlaygroundViewPayload(
  payloadVersion: number,
  payload: unknown,
): PlaygroundViewPayloadV1 | null {
  if (payloadVersion !== PLAYGROUND_VIEW_PAYLOAD_VERSION) return null;
  const result = PlaygroundViewPayloadV1Schema.safeParse(payload);
  return result.success ? result.data : null;
}
