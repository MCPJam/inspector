/**
 * The Cursor CLI harness as MCPJam runs it, in the cloud and on a member's
 * computer alike: the AI SDK's ACP adapter with the CLI pinned and checked
 * (`cursor-bootstrap.ts`), the login method Cursor's file and memory logins
 * need (`cursor-login-auth.ts`), host tool approval patched into the bridge
 * (`cursor-host-tool-approval.ts`) and approval inputs attached
 * (`acp-permission-input.ts`). The local Inspector layer bundles this bridge
 * (`cursor-local-bridge.ts`), so the two can't drift.
 */
import type { HarnessAgentAdapter } from "@ai-sdk/harness/agent";
import { createCursor } from "@ai-sdk/harness-cursor";
import { withAcpPermissionCallInput } from "./acp-permission-input.js";
import { pinCursorHarnessBootstrap } from "./cursor-bootstrap.js";
import { withCursorHostToolApproval } from "./cursor-host-tool-approval.js";
import { withCursorLoginAuthentication } from "./cursor-login-auth.js";

type CursorSettings = NonNullable<Parameters<typeof createCursor>[0]>;

export function createCursorHarness({
  auth,
  mcpServers,
}: {
  /** An explicit environment, so the adapter never looks for a credential of its own. */
  auth: CursorSettings["auth"];
  mcpServers: CursorSettings["mcpServers"];
}) {
  // Dual-`ai` boundary cast, same as the other adapters.
  return withAcpPermissionCallInput(withCursorHostToolApproval(withCursorLoginAuthentication(pinCursorHarnessBootstrap(
    createCursor({
      // An explicit empty key prevents ambient credential lookup. The backend
      // installs the temporary login before the runtime process starts.
      auth,
      // The framework replaces even empty keys with placeholders by default.
      // Keep the CLI on its installed login instead of trying a fake API key.
      credentialForwarding: () => "",
      // `session-config` delivery has no other channel, so a construction
      // that forgot the servers would be a silently tool-less turn.
      mcpServers,
    }) as unknown as HarnessAgentAdapter,
  ))));
}
