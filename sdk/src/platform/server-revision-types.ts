/**
 * Shapes of the server revision reads under
 * `/projects/{projectId}/servers/{serverId}/revisions`. A revision is one
 * stored capture of a server's tools and server info, recorded when either
 * changes.
 */

export type PlatformServerRevisionSource =
  | "connect"
  | "evalRun"
  | "traceRepair"
  | "chatSession";

export type PlatformServerRevisionSummary = {
  revisionNumber: number;
  capturedAt: number;
  source: PlatformServerRevisionSource;
  /** The eval run, repair job or chat session that captured it; null for a connect. */
  sourceId: string | null;
  counts: {
    tools: number;
    prompts?: number;
    resources?: number;
    resourceTemplates?: number;
  };
};

export type PlatformServerRevisionTool = {
  name: string;
  title?: string;
  description?: string;
  inputSchema?: unknown;
  outputSchema?: unknown;
  meta?: Record<string, unknown>;
  icons?: unknown[];
  annotations?: Record<string, boolean | undefined>;
  execution?: { taskSupport?: string };
};

export type PlatformServerRevision = PlatformServerRevisionSummary & {
  tools: PlatformServerRevisionTool[];
  /** The server's initialize result: serverInfo, capabilities, instructions. */
  discovery: Record<string, unknown> | null;
  captureError: string | null;
  /** Paths storage dropped for size; their values are unknown, not absent. */
  droppedFields: string[];
};

export type PlatformServerRevisionDiff = {
  from: PlatformServerRevisionSummary;
  to: PlatformServerRevisionSummary;
  tools: {
    added: PlatformServerRevisionTool[];
    removed: PlatformServerRevisionTool[];
    changed: Array<{
      name: string;
      changedFields: string[];
      before: PlatformServerRevisionTool;
      after: PlatformServerRevisionTool;
    }>;
  };
  /** One entry per changed server info field, e.g. `serverInfo.version`. */
  discovery: Array<{ field: string; before: unknown; after: unknown }>;
  droppedFields: { from: string[]; to: string[] };
};
