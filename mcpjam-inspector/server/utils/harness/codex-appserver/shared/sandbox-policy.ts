/**
 * The command-sandbox policy an UNATTENDED local Codex turn runs under, and
 * the one place both the host and the bridge read it from.
 *
 * WHY THIS IS NOT A PERMISSION MODE. `HarnessV1PermissionMode` is the
 * framework's closed union (`allow-reads | allow-edits | allow-all`), and an
 * unattended run genuinely is `allow-all` — nobody is there to approve
 * anything, so Codex runs with `approvalPolicy: never`. What makes that
 * acceptable on a user's own machine is not a fourth mode but Codex's OS
 * sandbox, so the policy travels as its own field on the bridge `start`
 * message and is set only by the local unattended arm.
 *
 * WHY IT IS EXPLICIT. Without a `turn/start.sandboxPolicy`, Codex's own
 * workspace-write default leaves `/tmp` writable. The run's private TMPDIR is
 * session-owned already (`session-env.ts`), so the explicit policy excludes
 * `/tmp` and keeps `$TMPDIR` (`excludeTmpdirEnvVar: false`) as the one extra
 * writable root.
 *
 * WHAT IT DOES AND DOES NOT CONTAIN — product copy must say exactly this:
 *   - sandboxed COMMAND writes outside the cwd (the run's scratch folder) and
 *     the private TMPDIR: blocked;
 *   - network for sandboxed commands: off;
 *   - reads: NOT restricted by this policy;
 *   - MCP tools: not commands. They run in the Inspector under its tool
 *     policy, outside this sandbox, with their own network and file access;
 *   - model traffic: brokered by MCPJam, outside this network restriction.
 */

/** `SandboxPolicy` (workspaceWrite arm) from the 0.149.1 app-server schema. */
export type CodexWorkspaceWriteSandboxPolicy = {
  type: "workspaceWrite";
  writableRoots: string[];
  networkAccess: boolean;
  excludeSlashTmp: boolean;
  excludeTmpdirEnvVar: boolean;
};

/**
 * The policy as it arrives on the wire, checked by hand: the bridge's start
 * message is only `JSON.parse`d by the framework, so the strict schema in
 * `codex-appserver-bridge-protocol.ts` never runs there. Exactly the five
 * workspace-write keys with the right types, or null.
 */
export function parseWorkspaceWriteSandboxPolicy(
  value: unknown,
): CodexWorkspaceWriteSandboxPolicy | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  const expected = [
    "excludeSlashTmp",
    "excludeTmpdirEnvVar",
    "networkAccess",
    "type",
    "writableRoots",
  ];
  const keys = Object.keys(record).sort();
  if (keys.length !== expected.length || keys.some((key, i) => key !== expected[i])) {
    return null;
  }
  if (
    record.type !== "workspaceWrite" ||
    !Array.isArray(record.writableRoots) ||
    !record.writableRoots.every((root) => typeof root === "string") ||
    typeof record.networkAccess !== "boolean" ||
    typeof record.excludeSlashTmp !== "boolean" ||
    typeof record.excludeTmpdirEnvVar !== "boolean"
  ) {
    return null;
  }
  return {
    type: "workspaceWrite",
    writableRoots: [...(record.writableRoots as string[])],
    networkAccess: record.networkAccess,
    excludeSlashTmp: record.excludeSlashTmp,
    excludeTmpdirEnvVar: record.excludeTmpdirEnvVar,
  };
}

/** D2: what an unattended local Codex eval or swarm turn runs under. */
export const LOCAL_UNATTENDED_SANDBOX_POLICY: Readonly<CodexWorkspaceWriteSandboxPolicy> =
  Object.freeze({
    type: "workspaceWrite",
    writableRoots: [],
    networkAccess: false,
    excludeSlashTmp: true,
    excludeTmpdirEnvVar: false,
  });

/**
 * A stable string for the policy, so a policy change is a configuration change
 * (a new thread, a new runtime fingerprint) rather than something a resumed
 * thread silently keeps.
 */
export function sandboxPolicyFingerprint(
  policy: Readonly<CodexWorkspaceWriteSandboxPolicy> | undefined,
): string {
  if (policy === undefined) return "none";
  return JSON.stringify({
    type: policy.type,
    writableRoots: [...policy.writableRoots].sort(),
    networkAccess: policy.networkAccess,
    excludeSlashTmp: policy.excludeSlashTmp,
    excludeTmpdirEnvVar: policy.excludeTmpdirEnvVar,
  });
}
