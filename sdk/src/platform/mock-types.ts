/**
 * The wire shapes of the mock operations. The route validates the definition,
 * so the client does not look inside it, and nothing from the Node-only
 * `@mcpjam/sdk/mocks` entry reaches the platform bundle.
 */

export type PlatformMockDefinition = object;

/** Whether a mock may call its real server. */
export type PlatformMockForwarding = "allow" | "block";

/** The forwarding policy in force, and where it comes from. */
export type PlatformMockPolicy = {
  forwarding: PlatformMockForwarding;
  /** The workspace's own setting, or the organization's for a project without a workspace. */
  scope: "workspace" | "organization";
  /** Epoch ms of the last change; null when never set (the default applies). */
  updatedAt: number | null;
};

/** A tool whose safety annotations a save made look safer than the real tool's. */
export type PlatformMockLoosened = { tool: string; hints: string[] };

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
  loosened: PlatformMockLoosened[];
};

/** What a create or a save answers: the saved version and the policy in force for the mock. */
export type PlatformMockWritten = PlatformMockSaved & {
  policy: PlatformMockPolicy;
};

/** Counts of what the definition states, by family. */
export type PlatformMockCounts = {
  tools: number;
  prompts: number;
  resources: number;
  resourceTemplates: number;
};

/** The paths a definition states (`tools.search.description`), the bounded start of the list. */
export type PlatformMockChangedPaths = {
  paths: string[];
  total: number;
  truncated: boolean;
};

/** A small read: identity, version, base, policy, counts and changed paths. Paged reads of the definition come later. */
export type PlatformMockServer = Omit<PlatformMockSaved, "created"> & {
  headVersion: number;
  policy: PlatformMockPolicy;
  counts: PlatformMockCounts;
  changedPaths: PlatformMockChangedPaths;
  createdAt: number | null;
};

export type PlatformMockForwardingPolicy = PlatformMockPolicy & {
  projectId: string;
  /** The mock the policy was read for; absent for the project's own setting. */
  mockId?: string;
};
