import type { UiToolAnnotations } from "./client-fulfilled-tools";

/**
 * WebMCP-shaped MCPJam UI tool snapshot entry — the `uiTools` wire shape of
 * `POST /api/web/mcpjam-agent`, the only route that accepts the first-party
 * UI catalog. Mirrors `UiToolEntry` in
 * `server/utils/chat-v2-orchestration.ts` so the client snapshotter and the
 * server validator share a single shape. Deliberately NOT part of the
 * chat-v2 request body: generic chat surfaces never ship MCPJam UI tools.
 *
 * Unlike app tools, UI tools are first-party and curated: `name` is the
 * model-facing tool name directly (reserved `ui_` prefix, validated at the
 * boundary), with no alias indirection.
 *
 * `annotations` carries the MCP `ToolAnnotations` hints and is what drives
 * approval policy (`uiToolCallNeedsApproval`). `readOnly` predates it and is
 * retained for wire compatibility: an old client ships only `readOnly`, and
 * the validator rejects a snapshot whose `readOnlyHint` contradicts it.
 */
export interface UiToolSnapshotEntry {
  name: string;
  description: string;
  inputSchema?: Record<string, unknown>;
  readOnly: boolean;
  annotations?: UiToolAnnotations;
}
