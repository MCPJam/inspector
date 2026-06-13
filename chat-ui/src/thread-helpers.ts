// Public subpath: the part/tool shape helpers, single-sourced for hosts (e.g.
// the inspector). It avoids the package's renderer/markdown component graph — it
// is not React-free, since getToolStateMeta returns lucide icon components.
export * from "./internal/thread-helpers";
