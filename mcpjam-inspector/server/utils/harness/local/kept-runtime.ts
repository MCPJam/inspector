/**
 * Keeping a local Codex runtime between chat turns, from the turn's side:
 * whether a turn keeps and adopts one, and the configuration it must match.
 * Behind `MCPJAM_LOCAL_KEEP_AGENT` (`localKeepAgentEnabled`), off by default.
 *
 * Codex only, as its definition declares (`keptBetweenTurns`). Its
 * bridge keeps one `app-server` while the runtime's configuration matches
 * (`codex-appserver/bridge/index.ts`), so the next turn attaches to it. Local
 * Claude Code has no warm query: its CLI exits at the end of every turn, so
 * there is nothing to keep.
 *
 * The fingerprint is the local path's own, and complete: the runtime
 * fingerprint the lane already keys on (harness, model, MCP servers,
 * permission mode, plugins, secrets hash, runtime, workspace, policy,
 * profile, command sandbox and whose key) plus the reasoning effort, the
 * skills, the system prompt, the Tool Approval setting and the environment
 * the process is started with. A kept process holds all of them from its
 * start, so any difference starts a fresh one. Not the hosted warm hash, which drops the model, the
 * servers and the permission mode because a hosted warm agent re-applies
 * them per message; a local runtime cannot. The organization key's revision
 * is compared when the adopting turn's fresh lease comes back.
 */
import { createHash } from "node:crypto";
import { localKeepAgentEnabled } from "../harness-flags.js";
import { localRuntimeOf } from "./runtimes/index.js";

export interface KeptRuntimeTurn {
  /** This turn's configuration (`keptRuntimeFingerprint`). */
  fingerprint: string;
  /** The runtime the lane's committed state names, when it names one. */
  committed?: { generation: string; stateVersion: number };
}

export interface KeptRuntimeConfiguration {
  /** The turn's runtime fingerprint (`harnessRuntimeFingerprint`). */
  runtime: string;
  reasoningEffort?: string;
  skillsHash?: string;
  systemPrompt?: string;
  /** Tool Approval: whether the runtime's requests are asked or answered. */
  requireToolApproval?: boolean;
  /** The environment the process is started with. Hashed, never kept. */
  env?: Readonly<Record<string, string>>;
}

export function keptRuntimeFingerprint(configuration: KeptRuntimeConfiguration): string {
  const env = Object.entries(configuration.env ?? {}).sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  );
  return createHash("sha256")
    .update(
      JSON.stringify([
        configuration.runtime,
        configuration.reasoningEffort ?? null,
        configuration.skillsHash ?? null,
        configuration.systemPrompt ?? null,
        configuration.requireToolApproval ?? null,
        env,
      ]),
    )
    .digest("hex");
}

/**
 * What a local turn asks for: keep its runtime when it ends, and adopt the
 * one its lane's committed state names. Nothing when the switch is off, for a
 * runtime that keeps no process between turns, for anything but a member's
 * own chat, or for an approval continuation, whose runtime is the one the
 * approval parked and ends with it, as before.
 */
export function keptLocalRuntimeTurn(args: {
  harnessId: string;
  ownerType: string | undefined;
  isApprovalResume: boolean;
  continuity:
    | { state: { resumeState: unknown } | null; stateVersion: number }
    | undefined;
  configuration: KeptRuntimeConfiguration;
}): KeptRuntimeTurn | undefined {
  if (
    !localKeepAgentEnabled() ||
    !localRuntimeOf(args.harnessId)?.keptBetweenTurns ||
    args.ownerType !== "direct-chat" ||
    args.isApprovalResume
  ) {
    return undefined;
  }
  const generation = bridgeGenerationOf(args.continuity?.state?.resumeState);
  return {
    fingerprint: keptRuntimeFingerprint(args.configuration),
    ...(generation !== undefined && args.continuity
      ? { committed: { generation, stateVersion: args.continuity.stateVersion } }
      : {}),
  };
}

/**
 * The live process generation a committed state belongs to: the bridge token
 * recorded in its lifecycle state. A restarted bridge mints a new token, so a
 * decision or a turn bound to the old one can never reach the new process.
 */
export function bridgeGenerationOf(state: unknown): string | undefined {
  if (!state || typeof state !== "object") return undefined;
  const data = (state as { data?: unknown }).data;
  if (!data || typeof data !== "object") return undefined;
  const bridge = (data as { bridge?: unknown }).bridge;
  if (!bridge || typeof bridge !== "object") return undefined;
  const token = (bridge as { token?: unknown }).token;
  return typeof token === "string" && token.length > 0 ? token : undefined;
}
