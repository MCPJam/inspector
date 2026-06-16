// Relocated to @mcpjam/widget-react (Phase 3d-ii-b). This shim preserves the
// existing `./useToolInputStreaming` import sites (the renderer, widget-replay,
// and the streaming tests).
export type {
  ToolState,
  UseToolInputStreamingParams,
  UseToolInputStreamingReturn,
} from "@mcpjam/widget-react";
export {
  PARTIAL_INPUT_THROTTLE_MS,
  STREAMING_REVEAL_FALLBACK_MS,
  SIGNATURE_MAX_DEPTH,
  SIGNATURE_MAX_ARRAY_ITEMS,
  SIGNATURE_MAX_OBJECT_KEYS,
  SIGNATURE_STRING_EDGE_LENGTH,
  getToolInputSignature,
  useToolInputStreaming,
} from "@mcpjam/widget-react";
