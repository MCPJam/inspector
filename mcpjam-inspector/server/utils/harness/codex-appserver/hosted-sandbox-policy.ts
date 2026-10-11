import type { CodexWorkspaceWriteSandboxPolicy } from "./shared/sandbox-policy.js";

/**
 * Hosted Codex with Tool Approval on.
 *
 * The bridge maps an approval mode to Codex's `untrusted` policy plus its
 * `workspace-write` command sandbox, whose defaults block the network and
 * writes outside the workspace and temp folders. On a user's machine that is
 * the point. In a hosted computer the box itself is the boundary, and Tool
 * Approval off runs `danger-full-access` there, so the defaults made an
 * APPROVED command weaker than the same command with approval off: measured on
 * the `mcpjam-computer` template, an approved `curl` could not resolve a host
 * while the unapproved one returned 200. This opens the sandbox to the whole
 * filesystem and the network, so approving grants what off grants; approval
 * stays the gate.
 *
 * Lives outside `shared/` on purpose: that folder is a local-pack input, and
 * this policy never reaches a local turn (the bridge refuses network access
 * whenever it is supervised locally).
 */
export const HOSTED_APPROVAL_SANDBOX_POLICY: Readonly<CodexWorkspaceWriteSandboxPolicy> =
  Object.freeze({
    type: "workspaceWrite",
    writableRoots: ["/"],
    networkAccess: true,
    excludeSlashTmp: false,
    excludeTmpdirEnvVar: false,
  });
