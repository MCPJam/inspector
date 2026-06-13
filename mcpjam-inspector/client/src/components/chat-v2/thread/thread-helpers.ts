// Single-sourced from @mcpjam/chat-ui. These pure part/tool shape helpers were
// extracted into the package (Tier A); the inspector re-exports them here so the
// many existing `@/components/chat-v2/thread/thread-helpers` import sites keep
// working against one implementation (no drift). The `/thread-helpers` subpath
// pulls only the pure helpers — not the package's React/markdown graph.
export * from "@mcpjam/chat-ui/thread-helpers";
