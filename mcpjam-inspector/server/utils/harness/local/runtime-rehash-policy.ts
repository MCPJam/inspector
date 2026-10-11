/**
 * Which files of a verified runtime pack are re-hashed before every spawn,
 * PER HARNESS.
 *
 * The full tree digest runs once per process per pack; every spawn after that
 * re-checks a stat snapshot and re-reads the bytes of the files listed here
 * (see `runtime-identity.ts` for the cost split behind the two tiers). What a
 * pack EXECUTES differs by harness — Claude Code runs the Agent SDK's native
 * `claude`, Codex runs `codex` plus its own sandbox helper and the host-tool
 * MCP entrypoint it spawns itself — so the list is the harness's to declare.
 *
 * Kept out of `runtime-identity.ts` on purpose. That module carries the tree
 * digest every pack is identified by, so it is a SHARED pack input: a Codex
 * pattern edited there would change Claude Code's pack fingerprint too, for
 * bytes that cannot change its pack. Nothing here changes what a pack digests
 * as — only which already-digested files are re-read later.
 */
import type { SupportedLocalHarnessId } from "./targets.js";

export interface RuntimeRehashPolicy {
  /** Re-hashed on every spawn: the pack's JavaScript entrypoints, which are
   *  small enough to read every time. (The bridge and its launcher are not
   *  pack files any more: the Inspector layer re-hashes them in full before
   *  every exec — `inspector-layer.ts`.) */
  always: readonly string[];
  /** Re-hashed under `MCPJAM_LOCAL_HARNESS_STRICT_REVERIFY=true`: the large
   *  binaries. Matched by pattern because vendor paths are platform-suffixed. */
  strict: readonly RegExp[];
}

const BUNDLED_NODE = /^bin\/node(\.exe)?$/;

export const RUNTIME_REHASH_POLICIES: Readonly<
  Record<SupportedLocalHarnessId, RuntimeRehashPolicy>
> = {
  "claude-code": {
    // The agent SDK the layer's bridge imports in-process (~1.4 MB, a few ms).
    always: ["node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs"],
    strict: [
      BUNDLED_NODE,
      /(^|\/)claude-agent-sdk-[a-z0-9-]+\/(claude|claude\.exe)$/,
      /(^|\/)claude-code-[a-z0-9-]+\/(claude|claude\.exe)$/,
    ],
  },
  codex: {
    // The wrapper the bridge runs with the pack's Node to find the CLI.
    always: ["node_modules/@openai/codex/bin/codex.js"],
    strict: [
      BUNDLED_NODE,
      // `@openai/codex-<platform>/vendor/<triple>/…`: the CLI and its
      // code-mode host, the bundled ripgrep, and the sandbox helpers Codex
      // execs (bubblewrap on Linux, the shell it wraps commands in).
      /(^|\/)@openai\/codex-[a-z0-9-]+\/vendor\/[^/]+\/(bin\/[^/]+|codex-path\/[^/]+|codex-resources\/bwrap|codex-resources\/zsh\/bin\/zsh|codex-resources\/[^/]+\.exe)$/,
      // The wrapper the bridge runs (`node …/bin/codex.js`) to find that CLI.
      /(^|\/)@openai\/codex\/bin\/codex\.js$/,
    ],
  },
};

/** The policy for a harness; an id with none gets the honest default —
 *  only the bundled Node — rather than a throw at spawn. */
export function rehashPolicyFor(harnessId: string): RuntimeRehashPolicy {
  return Object.prototype.hasOwnProperty.call(RUNTIME_REHASH_POLICIES, harnessId)
    ? RUNTIME_REHASH_POLICIES[harnessId as SupportedLocalHarnessId]
    : { always: [], strict: [BUNDLED_NODE] };
}
