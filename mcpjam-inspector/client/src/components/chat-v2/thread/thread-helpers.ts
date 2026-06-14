// Single-sourced from @mcpjam/chat-ui. These part/tool shape helpers were
// extracted into the package (Tier A); the inspector re-exports them here so the
// many existing `@/components/chat-v2/thread/thread-helpers` import sites keep
// working against one implementation (no drift). The `/thread-helpers` subpath
// avoids the package's renderer/markdown graph (not React-free — getToolStateMeta
// returns lucide icon components).
export * from "@mcpjam/chat-ui/thread-helpers";
