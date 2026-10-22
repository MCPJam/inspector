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
    // the adapter bridge's `canUseTool`, which every tool call passes through
    // before the CLI may run it; MCP tool names fall into its "edit" default,
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
  cursor: {
    // The one harness whose MODEL is not MCPJam's to choose. It authenticates
    // with the customer's own Cursor account and that account picks the model
    // (Cursor Auto), so a selection here would persist onto the host, show in
    // the editor, and reach nothing — a saved setting that silently lies about
    // what ran. The host carries the `cursor/auto` sentinel instead, which is
    // what the runtime actually resolves to.
    modelId: {
      enforced: false,
      note: "The Cursor CLI runs on your Cursor account, which chooses the model itself.",
    },
    // Permanent for the same reason: Cursor's CLI takes no temperature either.
    temperature: {
      enforced: false,
      note: "The Cursor CLI runs on your Cursor account and ignores temperature.",
    },
    // The ACP bridge pauses on its own built-ins: every tool call goes through
    // `session/request_permission`, and under the adapter's "allow-reads" mode
    // anything outside read/search/think/fetch emits a `tool-approval-request`
    // the turn waits on. Verified against a live cursor-agent.
    //
    // ENFORCED describes the NATIVE surface, which is what this control means
    // here. Whether Cursor also pauses on MCP-server tools is not yet measured
    // — the adapter's `supportsMcpToolApproval` is `false` pending that check,
    // so a host that requires approval AND selects servers is refused outright
    // rather than run with some calls unapproved. Refused, never silently
    // un-enforced.
    requireToolApproval: ENFORCED,
    // The real Cursor CLI owns its own tool discovery, same as the other two.
    progressiveToolDiscovery: {
      enforced: false,
      note: "The Cursor CLI does its own tool discovery.",
    },
  },
};

/** Runtime facts shared by the adapters, admission gates and client controls. */
export const HARNESS_DESCRIPTORS = {
  "claude-code": {
    displayName: "Claude Code", runtimeVersion: "2.1.245", mcpClient: "harness",
    modelAccess: "broker", local: true, guest: true,
    orgUpstream: { provider: "anthropic", profile: "anthropic-native" },
    protocol: "anthropic-messages", credential: null,
    controls: LOOP_CONTROLS["claude-code"], reasoningEfforts: HARNESS_REASONING_EFFORTS["claude-code"],
  },
  codex: {
    displayName: "Codex", runtimeVersion: "0.163.0", mcpClient: "mcpjam",
    modelAccess: "broker", local: true, guest: true,
    orgUpstream: { provider: "openai", profile: "openai-native" },
    protocol: "openai-responses", credential: null,
    controls: LOOP_CONTROLS.codex, reasoningEfforts: HARNESS_REASONING_EFFORTS.codex,
  },
  cursor: {
    displayName: "Cursor CLI", runtimeVersion: "2026.10.01-e373342", mcpClient: "harness",
    modelAccess: "external-account", local: false, guest: false,
    orgUpstream: null, protocol: null,
    credential: { env: "CURSOR_API_KEY", label: "Cursor API key",
      binding: { hosts: ["api2.cursor.sh"], header: "authorization", template: "Bearer {}" } },
    controls: LOOP_CONTROLS.cursor, reasoningEfforts: HARNESS_REASONING_EFFORTS.cursor,
  },
} as const satisfies Record<Harness, object>;

export const LOCAL_HARNESS_IDS = HARNESS_IDS.filter(
  (id): id is "claude-code" | "codex" => HARNESS_DESCRIPTORS[id].local,
);

/** Missing/unknown selectors never gain MCPJam-owned extension authority. */
export function usesMcpjamClient(input: { agentLoop?: string | null; harness?: string | null }): boolean {
  if (input.agentLoop && input.harness) return false;
  const id = input.agentLoop ?? input.harness;
  if (!id) return true;
  if (!Object.hasOwn(HARNESS_DESCRIPTORS, id)) return false;
  return Boolean(input.agentLoop) || HARNESS_DESCRIPTORS[id as Harness].mcpClient === "mcpjam";
}
