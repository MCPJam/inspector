// Public subpath: Tier-A-compatible trace/replay adaptation logic. Converts
// trace/snapshot data into AI SDK `UIMessage`s + `ToolRenderOverride`s, without
// loading the React renderer/markdown graph. Note: this is provider-free and
// package-safe, but it is not "pure rendering" — it knows widget metadata and
// the `ToolRenderOverride` shape.
export * from "./internal/trace-adapter";
export * from "./internal/persisted-execution-replay";
