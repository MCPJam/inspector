/**
 * The wire shapes of the mock operations. The route builds this JSON and
 * validates the definition, so the client does not look inside it. The change
 * list is the one `diffMockDefinitions` builds; its types are imported
 * type-only, so nothing from the Node-only `@mcpjam/sdk/mocks` entry reaches
 * the platform bundle.
 */
import type { MockChange, MockFieldChange } from "../mocks/change-list.js";

export type PlatformMockDefinition = object;
export type PlatformMockChange = MockChange;
export type PlatformMockFieldChange = MockFieldChange;

/** What a create or a save answers; `created: false` means it equalled the head. */
export type PlatformMockSaved = {
  id: string;
  name: string;
  projectId: string;
  baseServerId: string | null;
  /**
   * Where an MCP client reaches the mock, with an MCPJam API key. Null on a
   * hosted deployment that configures no public URL.
   */
  address: string | null;
  version: number;
  contentHash: string;
  created: boolean;
  dryRun: boolean;
  changes: PlatformMockChange[];
};

/** The real server's current values for what the definition edits. */
export type PlatformMockRealServer = {
  /** `unreachable` says why in `message`; `none` is a mock from nothing. */
  status: "read" | "unreachable" | "none";
  message?: string;
  serverInfo?: Record<string, unknown>;
  instructions?: string;
  tools: Array<{
    tool: string;
    realTool: string;
    found: boolean;
    /** The real value of each field the entry edits; `params.<name>` is a parameter's schema. */
    current: Record<string, unknown>;
  }>;
};

export type PlatformMockServer = Omit<PlatformMockSaved, "created" | "dryRun" | "changes"> & {
  headVersion: number;
  definition: PlatformMockDefinition;
  createdAt: number | null;
  /** With `sinceVersion`: what changed from it to `version`. */
  sinceVersion?: number;
  changes?: PlatformMockChange[];
  realServer: PlatformMockRealServer;
};
