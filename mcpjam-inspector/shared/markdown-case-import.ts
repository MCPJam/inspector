/**
 * The document ceiling, shared so the dialog can refuse an oversized file
 * before reading it and the authoring routes can refuse one that arrives
 * anyway. The authoritative twin is the backend's `MAX_MARKDOWN_BYTES`
 * (`convex/evalImport/types.ts`), which every authoring input schema enforces.
 */
export const MAX_MARKDOWN_BYTES = 100 * 1024;
