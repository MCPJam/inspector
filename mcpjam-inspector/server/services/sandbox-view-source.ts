import type { Context } from "hono";
import type { SandboxViewSource } from "@mcpjam/sdk/widget-runtime";
import { issueSandboxSourceReceipt } from "./sandbox-view-policy.js";
import {
  isSandboxWebRequest,
  localSandboxSession,
  sandboxViewOwner,
} from "./sandbox-view-owner.js";

/** Anonymous compatibility reads receive no authority to prepare a declared-policy view. */
export async function sandboxSourceReceipt(
  c: Context,
  source: SandboxViewSource,
  html: string,
  csp: unknown,
  projectId?: string,
): Promise<string | undefined> {
  if (!isSandboxWebRequest(c) && !localSandboxSession(c)) return undefined;
  return issueSandboxSourceReceipt(
    await sandboxViewOwner(c, projectId),
    source,
    html,
    csp,
  );
}
