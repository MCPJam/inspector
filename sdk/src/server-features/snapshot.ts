/**
 * Inspection snapshot envelope v3, as the connect producer writes it and the
 * backend stores it (`serverInspections.latestSnapshot`).
 *
 * Convex rejects field names that start with `$` or `_`, so the backend strips
 * them from nested objects. Anything that needs those keys travels as a JSON
 * string beside the stripped object (`metaJson`, `inputSchemaJson`, …), which
 * Convex stores verbatim. Readers prefer the JSON string when present.
 *
 * `coverage` says what the producer captured completely. Older envelopes
 * (v1, v2) have none, so readers treat every part as not captured and never
 * infer a gap from them.
 */

import type { CoverageKey, CoverageState, ListCacheHints } from "./types.js";

export const SERVER_FEATURE_SNAPSHOT_VERSION = 3;

/** Upper bound on any `*Json` string the producer writes. */
export const SNAPSHOT_JSON_FIELD_MAX_BYTES = 16 * 1024;

export interface SnapshotIcon {
  src: string;
  mimeType?: string;
  sizes?: string[];
  theme?: "light" | "dark";
}

/** Fields every v3 descriptor may carry for `_meta` fidelity. */
interface SnapshotDescriptorBase {
  name: string;
  title?: string;
  description?: string;
  icons?: SnapshotIcon[];
  /** `_meta` with reserved keys stripped (Convex-safe). */
  meta?: Record<string, unknown>;
  /** Full `_meta` as JSON, when present and within the size bound. */
  metaJson?: string;
}

export interface SnapshotToolV3 extends SnapshotDescriptorBase {
  inputSchema?: unknown;
  outputSchema?: unknown;
  /** Full schema JSON when stripping `$`/`_` keys would change it. */
  inputSchemaJson?: string;
  outputSchemaJson?: string;
  annotations?: {
    title?: string;
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    idempotentHint?: boolean;
    openWorldHint?: boolean;
  };
  execution?: { taskSupport?: "forbidden" | "optional" | "required" };
}

export interface SnapshotResourceV3 extends SnapshotDescriptorBase {
  uri: string;
  mimeType?: string;
  size?: number;
  annotations?: Record<string, unknown>;
}

export interface SnapshotResourceTemplateV3 extends SnapshotDescriptorBase {
  uriTemplate: string;
  mimeType?: string;
  annotations?: Record<string, unknown>;
}

export interface SnapshotPromptV3 extends SnapshotDescriptorBase {
  arguments?: Array<{ name: string; description?: string; required?: boolean }>;
}

export interface SnapshotSkillV3 {
  name: string;
  description?: string;
  uri?: string;
}

export interface SnapshotDiscoveryV3 {
  protocolVersion?: string;
  supportedVersions?: string[];
  serverInfo?: {
    name?: string;
    title?: string;
    version?: string;
    description?: string;
    websiteUrl?: string;
    icons?: SnapshotIcon[];
  };
  /** Raw capabilities (reserved keys stripped), unknown keys kept. */
  capabilities?: Record<string, unknown>;
  /** Full capabilities JSON when stripping would lose keys. */
  capabilitiesJson?: string;
  instructions?: string;
  meta?: Record<string, unknown>;
  metaJson?: string;
}

export type SnapshotCoverage = Partial<Record<CoverageKey, CoverageState>>;

export interface ServerFeatureSnapshotServerV3 {
  serverId: string;
  tools: SnapshotToolV3[];
  discovery?: SnapshotDiscoveryV3;
  resources?: SnapshotResourceV3[];
  resourceTemplates?: SnapshotResourceTemplateV3[];
  prompts?: SnapshotPromptV3[];
  skills?: SnapshotSkillV3[];
  /** Cache hints and page counts seen on each list result. */
  listHints?: Partial<
    Record<"tools" | "resources" | "resourceTemplates" | "prompts", ListCacheHints>
  >;
  /** Transport the connection used. */
  transport?: "stdio" | "streamable-http" | "sse";
  coverage?: SnapshotCoverage;
  captureError?: string;
}

export interface ServerFeatureSnapshotV3 {
  version: typeof SERVER_FEATURE_SNAPSHOT_VERSION;
  capturedAt: number;
  servers: ServerFeatureSnapshotServerV3[];
}
