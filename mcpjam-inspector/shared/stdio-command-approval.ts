/**
 * Per-device approval of the command a STDIO server runs (PLB-192).
 *
 * A project server's `command`/`args`/`env` is editable by every workspace
 * member, and the local inspector spawns it on this machine with the user's
 * privileges. The local server refuses to spawn until this device has
 * approved the exact launch spec, and asks again when it changes.
 *
 * One source of truth for the wire shape: the local server builds the
 * refusal (`utils/stdio-command-approvals.ts`) and the client reads it
 * (`lib/stdio-command-approval.ts`).
 */
export const STDIO_COMMAND_APPROVAL_REQUIRED_REASON =
  "stdio_command_approval_required";

export interface StdioCommandApprovalTerms {
  serverId: string;
  /**
   * SHA-256 (hex) of the exact launch spec: command, args, env names AND
   * values, working directory. Env values are part of the hash because they
   * can change what runs (`NODE_OPTIONS`, `PATH`, ...), but they never leave
   * the server; only the names are shown.
   */
  fingerprint: string;
  command: string;
  args: string[];
  envNames: string[];
  cwd?: string;
  /** This device had approved an earlier version of the command. */
  previouslyApproved: boolean;
}
