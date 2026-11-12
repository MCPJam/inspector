import { HARNESS_IDS, HARNESS_REASONING_EFFORTS, type Harness } from "@mcpjam/sdk/host-config/internal";

type HarnessControlState = { enforced: true } | { enforced: false; note: string };
type HarnessLoopControl = "modelId" | "temperature" | "requireToolApproval" | "progressiveToolDiscovery";
const ENFORCED = { enforced: true } as const;
const LOOP_CONTROLS: Record<
  Harness,
  Record<HarnessLoopControl, HarnessControlState>
> = {
  "claude-code": {
    // MCPJam brokers this harness's model credentials, so the selected model is
    // the model the runtime is launched with.
    modelId: ENFORCED,
    // Permanent: the Claude Code CLI exposes no temperature knob.
    temperature: {
      enforced: false,
      note: "Claude Code runs its own loop and ignores temperature.",
    },
    // Claude Code pauses on all three surfaces: its own built-ins, its
    // host-executed tools, and — under `approvalPermissionMode: "allow-reads"`
    // — the MCP tools its in-sandbox client calls. The interposition point is
    // the adapter bridge's `canUseTool`, which the CLI calls only for a call
    // its own permission check would ask about. It allows MCPJam's host tools
    // (they run on the host, which gates them) and read-only kinds (Read,
    // Glob, Grep, WebFetch, WebSearch, ReadMcpResource, Skill, …) without
    // asking. An MCP tool name falls into its kind table's "edit" default,
    // which "allow-reads" gates. This entry previously read `enforced: false`
    // on the belief that MCP tools were unreachable, and a turn on an approval
    // host with any server selected was REFUSED outright. It isn't anymore.
    requireToolApproval: ENFORCED,
    // The real Claude Code owns its own tool discovery; MCPJam's progressive
    // meta-tools are an emulated-loop mechanism and don't apply to a harness.
    progressiveToolDiscovery: {
      enforced: false,
      note: "Claude Code does its own tool discovery.",
    },
  },
  codex: {
    // Brokered, same as Claude Code — the selection reaches the runtime.
    modelId: ENFORCED,
    // Permanent: the Codex CLI exposes no temperature knob to the host.
    temperature: {
      enforced: false,
      note: "Codex runs its own loop and ignores temperature.",
    },
    // Codex runs on MCPJam's app-server adapter, which pauses on every command
    // and file change and gates host-executed MCP tools before they run.
    requireToolApproval: ENFORCED,
    // The real Codex owns its own tool discovery.
    progressiveToolDiscovery: {
      enforced: false,
      note: "Codex does its own tool discovery.",
    },
  },
  "copilot-cli": {
    modelId: ENFORCED, requireToolApproval: ENFORCED,
    temperature: { enforced: false, note: "GitHub Copilot CLI controls temperature." },
    progressiveToolDiscovery: { enforced: false, note: "GitHub Copilot CLI receives the selected tools at turn start." },
  },
  cursor: {
    modelId: ENFORCED,
    // Permanent for the same reason: Cursor's CLI takes no temperature either.
    temperature: {
      enforced: false,
      note: "The Cursor CLI runs on your Cursor account and ignores temperature.",
    },
    // The ACP bridge pauses on its own built-ins: every tool call goes through
    // `session/request_permission`, and under the adapter's "allow-reads" mode
    // anything outside read/search/think/fetch emits a `tool-approval-request`
    // the turn waits on. Verified against a live cursor-agent, MCP-server
    // tools included: Cursor asks (kind `other`) before it sends the call.
    requireToolApproval: ENFORCED,
    // The real Cursor CLI owns its own tool discovery, same as the other two.
    progressiveToolDiscovery: {
      enforced: false,
      note: "The Cursor CLI does its own tool discovery.",
    },
  },
  opencode: {
    // Brokered Anthropic, same as Claude Code — the selected model is the
    // model the runtime is launched with, including title/compaction pins.
    modelId: ENFORCED,
    temperature: {
      enforced: false,
      note: "OpenCode runs its own loop and ignores temperature.",
    },
    // OpenCode pauses on native built-ins, and MCPJam host-executed tools
    // go through HarnessAgent's toolApproval before they run.
    requireToolApproval: ENFORCED,
    progressiveToolDiscovery: {
      enforced: false,
      note: "OpenCode does its own tool discovery.",
    },
  },
};

/** Everywhere a runtime can run. Keep parity with the backend's list. */
export const HARNESS_SURFACES = [
  "playground", "api", "evals", "events", "swarms", "user-testing", "guests", "local",
] as const;
export type HarnessSurface = (typeof HARNESS_SURFACES)[number];

/** The surface a turn's `sourceType` names. `direct` is the Playground or the
 *  v1 API, so it names neither: each of those routes says which it is. */
export function harnessSurfaceOfSource(sourceType: string | undefined): HarnessSurface | undefined {
  switch (sourceType) {
    case "scenario": return "user-testing";
    case "eval": return "evals";
    case "swarm": return "swarms";
    case "event": return "events";
    default: return undefined;
  }
}

/**
 * Runtime facts shared by the adapters, admission gates and client controls.
 * `protocol` is the wire API the harness speaks to its model; `orgKeys` says
 * whether it may run on an organization connection that serves that API.
 * A runtime runs on every surface except those `unavailableOn` names, each
 * with the reason a user reads when a turn there is refused.
 */
export const HARNESS_DESCRIPTORS = {
  "claude-code": {
    displayName: "Claude Code", runtimeVersion: "2.1.290", mcpClient: "harness",
    modelAccess: "broker", orgKeys: true,
    protocol: "anthropic-messages", credential: null,
    unavailableOn: {},
    controls: LOOP_CONTROLS["claude-code"], reasoningEfforts: HARNESS_REASONING_EFFORTS["claude-code"],
  },
  codex: {
    displayName: "Codex", runtimeVersion: "0.163.0", mcpClient: "mcpjam",
    modelAccess: "broker", orgKeys: true,
    protocol: "openai-responses", credential: null,
    unavailableOn: {},
    controls: LOOP_CONTROLS.codex, reasoningEfforts: HARNESS_REASONING_EFFORTS.codex,
  },
  "copilot-cli": {
    displayName: "GitHub Copilot CLI", runtimeVersion: "1.0.92", mcpClient: "mcpjam",
    modelAccess: "broker", orgKeys: true,
    protocol: "openai-responses", credential: null,
    unavailableOn: {
      local: "GitHub Copilot CLI can't run on your computer yet. Run it in the cloud instead.",
    },
    controls: LOOP_CONTROLS["copilot-cli"], reasoningEfforts: HARNESS_REASONING_EFFORTS["copilot-cli"],
  },
  cursor: {
    displayName: "Cursor CLI", runtimeVersion: "2026.11.05-86047df", mcpClient: "harness",
    modelAccess: "external-account", orgKeys: false, protocol: null,
    unavailableOn: {
      api: "Cursor CLI runs only in the Playground, evals and swarms. Use it there, or choose a different client.",
      events: "Cursor CLI runs only in the Playground, evals and swarms. Use it there, or choose a different client.",
      "user-testing": "Cursor CLI runs only in the Playground, evals and swarms. Choose a different client for this study.",
      local: "Cursor CLI can't run on your computer yet. Run it in the cloud instead.",
      guests: "Cursor CLI runs on the organization's own Cursor account, so guests can't use it.",
    },
    credential: { env: "CURSOR_API_KEY", label: "Cursor API key",
      binding: { hosts: ["api2.cursor.sh"], header: "authorization", template: "Bearer {}" } },
    controls: LOOP_CONTROLS.cursor, reasoningEfforts: HARNESS_REASONING_EFFORTS.cursor,
  },
  opencode: {
    displayName: "OpenCode", runtimeVersion: "1.18.34", mcpClient: "mcpjam",
    modelAccess: "broker", orgKeys: true,
    protocol: "anthropic-messages", credential: null,
    unavailableOn: {
      local: "OpenCode can't run on your computer yet. Run it in the cloud instead.",
      guests: "OpenCode isn't available to guests until it's tested with them.",
    },
    controls: LOOP_CONTROLS.opencode, reasoningEfforts: HARNESS_REASONING_EFFORTS.opencode,
  },
} as const satisfies Record<
  Harness,
  { unavailableOn: Partial<Record<HarnessSurface, string>>; [fact: string]: unknown }
>;

/** Why `id` does not run on `surface`, or `undefined` where it does. */
export function harnessSurfaceRefusal(id: Harness, surface: HarnessSurface): string | undefined {
  const unavailableOn: Partial<Record<HarnessSurface, string>> = HARNESS_DESCRIPTORS[id].unavailableOn;
  return unavailableOn[surface];
}

/** The runtimes that declare no exception for `surface`. */
export type HarnessIdOn<S extends HarnessSurface> = {
  [K in Harness]: S extends keyof (typeof HARNESS_DESCRIPTORS)[K]["unavailableOn"] ? never : K;
}[Harness];

export const LOCAL_HARNESS_IDS = HARNESS_IDS.filter(
  (id): id is HarnessIdOn<"local"> => !harnessSurfaceRefusal(id, "local"),
);

/** A runtime that runs on the member's own computer. */
export type LocalHarnessId = (typeof LOCAL_HARNESS_IDS)[number];

/**
 * The local runtime a caller means when it names none. Claude Code was the
 * only one when the local routes, the install CLI, the stores and the client's
 * saved consent were written, so a request without a harness id still means it.
 */
export const DEFAULT_LOCAL_HARNESS_ID = "claude-code" satisfies LocalHarnessId;

/** The PostHog flag that rolls a runtime out on members' computers. */
export type LocalHarnessRolloutFlag =
  | "local-harness-enabled"
  | `local-${Exclude<LocalHarnessId, "claude-code">}-enabled`;

/**
 * Each local runtime rolls out on its own flag, named after it. Claude Code's
 * predates the others and keeps the name it shipped under. A flag's cohort
 * should sit inside the runtime's hosted flag: the backend refuses a client
 * for a runtime the member cannot use, so a member enabled here but not there
 * could set the runtime up and then fail to create the client.
 */
export function localHarnessRolloutFlag(id: LocalHarnessId): LocalHarnessRolloutFlag {
  return id === "claude-code" ? "local-harness-enabled" : `local-${id}-enabled`;
}

/** The harness a client config runs: its agent loop when set, else its harness. */
export function effectiveHarnessId(
  config: { agentLoop?: string | null; harness?: string | null } | null | undefined,
): string | null {
  return config?.agentLoop ?? config?.harness ?? null;
}

/** Missing/unknown selectors never gain MCPJam-owned extension authority. */
export function usesMcpjamClient(input: { agentLoop?: string | null; harness?: string | null }): boolean {
  if (input.agentLoop && input.harness) return false;
  const id = input.agentLoop ?? input.harness;
  if (!id) return true;
  if (!Object.hasOwn(HARNESS_DESCRIPTORS, id)) return false;
  return Boolean(input.agentLoop) || HARNESS_DESCRIPTORS[id as Harness].mcpClient === "mcpjam";
}
