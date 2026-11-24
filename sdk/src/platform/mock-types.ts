/**
 * The wire shapes of the mock operations. The route builds this JSON and
 * validates the definition, so the client does not look inside it. The change
 * list is the one `diffMockDefinitions` builds; its types are imported
 * type-only, so nothing from the Node-only `@mcpjam/sdk/mocks` entry reaches
 * the platform bundle.
 */
import type { MockChange, MockFieldChange } from "../mocks/change-list.js";
import type { ChangeEntry } from "../climbs/types.js";

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

/** The real server's current values for one prompt, resource or template the definition edits. */
export type PlatformMockRealItem = {
  /** The prompt name, resource URI or URI template the entry is keyed by. */
  key: string;
  found: boolean;
  /** The real value of each field the entry edits. */
  current: Record<string, unknown>;
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
  /** Present when the definition edits prompts, resources or templates. */
  prompts?: PlatformMockRealItem[];
  resources?: PlatformMockRealItem[];
  resourceTemplates?: PlatformMockRealItem[];
};

/** A call to a tool with saved answers that none of them matched. */
export type PlatformMockUnmatchedCall = {
  tool: string;
  /** The input that found no answer; `{}` when it was too large to keep. */
  arguments: Record<string, unknown>;
  /** The version that was serving when it was last seen. */
  version: number;
  /** How many times it was seen. */
  count: number;
  lastSeenAt: number;
};

export type PlatformMockServer = Omit<
  PlatformMockSaved,
  "created" | "dryRun" | "changes"
> & {
  headVersion: number;
  definition: PlatformMockDefinition;
  createdAt: number | null;
  /** With `sinceVersion`: what changed from it to `version`. */
  sinceVersion?: number;
  changes?: PlatformMockChange[];
  realServer: PlatformMockRealServer;
  /**
   * The most recent calls no saved answer matched, newest first: the input to
   * write a case for. Bounded per mock by the backend. Empty when there are
   * none or the list could not be read.
   */
  unmatchedCalls: PlatformMockUnmatchedCall[];
  /** Everything the mock can change on this server, ranked, with who reads each. Present when the real server was read. */
  whatCanChange?: ChangeEntry[];
};
