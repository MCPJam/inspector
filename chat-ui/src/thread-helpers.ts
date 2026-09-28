// Public subpath: the part/tool shape helpers, single-sourced for hosts (e.g.
// the inspector). It avoids the package's renderer/markdown component graph — it
// is not React-free, since getToolStateMeta returns lucide icon components.
export * from "./internal/thread-helpers";
// The adapter-to-renderer channel for a readable tool result travels on the
// same parts these helpers describe, and hosts have to read it off those parts
// exactly the way the package does — so it ships on the same graph-free
// subpath rather than forcing a host to pull the barrel in for one predicate.
export * from "./internal/trace-display";
