/**
 * The variant contract's data shapes. A variant is a saved server's live
 * `tools/list` surface plus edits, served by passing every request through to
 * the base. This slice edits tool descriptions only.
 */

/** One edit: replace a tool's description. */
export type VariantEdit = {
  feature: "tools.description";
  /** The tool name exactly as the base's `tools/list` returns it. */
  target: string;
  op: "set";
  /** The new description. */
  value: string;
};

/** An edit as a caller sent it, before validation narrows it to a `VariantEdit`. */
export type VariantEditInput = {
  feature: string;
  target: string;
  op: string;
  value: unknown;
};

/** The hash of one edited tool, taken from the pinned read of the base. */
export type VariantToolHash = { tool: string; hash: string };

/** What the backend stores, and returns from authorize-batch. */
export type VariantDefinition = {
  /** The `serverVariants` row id. */
  variantId: string;
  /** The variant's own `servers` row id. */
  serverId: string;
  baseServerId: string;
  edits: VariantEdit[];
  editsHash: string;
  baseSurfaceHash: string;
  toolHashes: VariantToolHash[];
  contentHash: string;
};

/** A Tool object exactly as the base's `tools/list` returned it. */
export type VariantTool = { name: string; [key: string]: unknown };

/** One changed field, for showing a variant against its base. */
export type VariantDiffEntry = {
  tool: string;
  field: "description";
  /** `null` when the base tool has no description. */
  before: string | null;
  after: string;
};

/** Validated edits and every hash a variant needs, before the backend stores it. */
export type VariantDraft = {
  edits: VariantEdit[];
  editsHash: string;
  baseSurfaceHash: string;
  toolHashes: VariantToolHash[];
  contentHash: string;
  diff: VariantDiffEntry[];
};
