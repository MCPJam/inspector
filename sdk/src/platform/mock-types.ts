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

/**
 * What a create or a save answers: the saved version, the policy in force for
 * the mock and the same bounded change summary the default read gives (its
 * `nextCursor` continues the list with a read).
 */
export type PlatformMockWritten = PlatformMockSaved & {
  policy: PlatformMockPolicy;
  counts: PlatformMockCounts;
  changes: { items: PlatformMockChange[]; page: PlatformMockPage };
};

/**
 * Counts of the definition: `changes` is the number of changes (a tool,
 * prompt, resource or template it adds, edits or hides, plus each server-wide
 * setting it states), and the rest split the entries by family.
 */
export type PlatformMockCounts = {
  changes: number;
  tools: number;
  prompts: number;
  resources: number;
  resourceTemplates: number;
};

/** The page a bounded read returned. `end` is true on the last one; otherwise `nextCursor` continues. */
export type PlatformMockPage = {
  offset: number;
  count: number;
  total: number;
  end: boolean;
  nextCursor?: string;
  /** `characters` when the page is a chunk of one string. */
  unit?: "characters";
};

/** One change: an entry the definition adds, edits or hides, or one server-wide setting. */
export type PlatformMockChange = {
  /** From the definition's root: `tools.search`, `instructions`. */
  path: string;
  target: "server" | "tool" | "prompt" | "resource" | "resourceTemplate" | "skill" | "app";
  /** The name a client sees; absent for a server-wide setting. */
  name?: string;
  /** Leaf paths inside the change, which a field read or patch takes. */
  fields: string[];
  summary: string;
};

export type PlatformMockFamily = "tools" | "prompts" | "resources" | "resourceTemplates";

/** The real server's saved listing the read used: this caller's, another member's private one, or none. */
export type PlatformMockListingState = "saved" | "private" | "none";

/** The default read: identity, version, base, policy, counts and a bounded page of changes. */
export type PlatformMockServer = Omit<PlatformMockSaved, "created"> & {
  view: "summary";
  headVersion: number;
  policy: PlatformMockPolicy;
  counts: PlatformMockCounts;
  changes: { items: PlatformMockChange[]; page: PlatformMockPage };
  createdAt: number | null;
};

/** What every other read carries with its view. */
type PlatformMockReadBase = {
  id: string;
  /** The mock's own name; an entry's name is `name` in the entry and value views. */
  mockName: string;
  projectId: string;
  /** The version this page was read from. A cursor stays on it while the head moves on. */
  version: number;
  headVersion: number;
  contentHash: string;
  listing: PlatformMockListingState;
};

/** Names of a family, the real server's and the definition's, one page. */
export type PlatformMockList = PlatformMockReadBase & {
  view: "list";
  family: PlatformMockFamily;
  search?: string;
  entries: {
    name: string;
    kind: "real" | "edited" | "added";
    hidden?: true;
    title?: string;
    description?: string;
  }[];
  page: PlatformMockPage;
};

/** One entry: what the definition states and what a client sees. Long values are `{ $omitted, path }` markers to read by path. */
export type PlatformMockEntry = PlatformMockReadBase & {
  view: "entry";
  family: PlatformMockFamily;
  name: string;
  kind: "real" | "edited" | "added";
  stated?: unknown;
  effective: unknown;
};

/** One field or nested path. A string comes in ordered chunks: join `value` across pages until `page.end`. */
export type PlatformMockValue = PlatformMockReadBase & {
  view: "value";
  family?: PlatformMockFamily;
  path: string[];
  /** Whether the definition states this path, as against the real server's own value. */
  stated: boolean;
  type: string;
  value: unknown;
  page?: PlatformMockPage;
};

export type PlatformMockRead =
  | PlatformMockServer
  | PlatformMockList
  | PlatformMockEntry
  | PlatformMockValue;

/** What a read can ask for beyond the default. */
export type PlatformMockReadSelector = {
  version?: number;
  family?: PlatformMockFamily;
  /** The tool or prompt name, resource URI or template, exactly. */
  name?: string;
  /** Inside the entry (or the definition without a family): dotted, or a list of keys. */
  path?: string | string[];
  /** Names containing this text. Needs `family`. */
  search?: string;
  limit?: number;
  /** From a previous page of the same read. */
  cursor?: string;
};

/** One override the real server no longer fits. */
export type PlatformMockBinding = {
  path: string;
  tool: string;
  realTool: string;
  code: "target_missing" | "param_missing" | "param_required" | "value_incompatible";
  message: string;
};

/** What a refresh found: the real server now against the listing the version saved. */
export type PlatformMockRefresh = PlatformMockReadBase & {
  view: "refresh";
  applied: boolean;
  differences: {
    family: PlatformMockFamily;
    added: string[];
    removed: string[];
    changed: string[];
    /** Names beyond the ones listed. */
    more: number;
  }[];
  brokenOverrides: PlatformMockBinding[];
  brokenTotal: number;
  /** Set when `apply` saved the new listing as a new version. */
  saved?: PlatformMockSaved;
};

/** A one-path patch's answer: the saved version and the definition path changed. */
export type PlatformMockPatched = PlatformMockSaved & { path: string[] };

export type PlatformMockForwardingPolicy = PlatformMockPolicy & {
  projectId: string;
  /** The mock the policy was read for; absent for the project's own setting. */
  mockId?: string;
};

/**
 * A test run of a mock: a version pinned, with its own copy of the version's
 * records, at a URL only the person who opened it can use. `reset` returns a
 * fresh URL at the next epoch; the old one is refused.
 */
export type PlatformMockRun = {
  runId: string;
  mockId: string;
  projectId: string;
  /** The version the run pinned. */
  version: number;
  /** Raised by every reset; a call on an older epoch's URL is refused. */
  epoch: number;
  /** Epoch milliseconds; a run lasts 24 hours from opening. */
  expiresAt: number;
  /** The run's MCP URL; null when this deployment has no public address to give. */
  runUrl: string | null;
};

export type PlatformMockRunClosed = { runId: string; projectId: string; closed: true };
