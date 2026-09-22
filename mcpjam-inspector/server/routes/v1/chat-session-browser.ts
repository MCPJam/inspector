import { BrowserAdmissionError } from "../../utils/computers/browser-admission-error";
import type { BrowserUnattendedPolicy } from "../../../shared/client-fulfilled-tools";
import {
  browserSessionPolicySchema,
  browserPolicyWithin,
  compileBrowserPolicy,
  intersectBrowserPolicies,
  type EffectiveBrowserPolicy,
} from "../../../shared/browser-session-policy";
import { parseBrowserToolPolicy } from "../../services/evals/browser-tool-policy";
import { BrowserSessionService } from "../../services/browserd/session-service";
import { ensureHostedConversationSession } from "../../utils/built-in-tools/browser";

export class SessionBrowserError extends Error {
  constructor(
    readonly code: string,
    readonly status: 400 | 409 | 422 | 503,
    message: string,
    readonly retryAfterMs?: number,
    readonly limit?: number,
  ) {
    super(message);
  }
}
export type ConversationBrowser = {
  sessionId: string;
  browserSessionId: string;
  policy: BrowserUnattendedPolicy;
  policyVersion?: number;
  profileId?: string;
  hostId?: string;
  environmentId?: string;
  state: "active" | "sleeping" | "closed";
  lastBootId?: string;
  box?: { sandboxRowId: string } | { computerId: string };
};
function canonical(policy: BrowserUnattendedPolicy): string {
  return JSON.stringify({
    mode: policy.mode,
    origins: [...(policy.originAllowlist ?? [])].sort(),
    tools: [...(policy.toolAllowlist ?? [])].sort(),
  });
}
export function resolveTurnBrowserPolicy(args: {
  body: { policy?: unknown; profileId?: string };
  stored?: ConversationBrowser | null;
  hostId?: string;
  hostRuntimeConfig?: {
    builtInToolIds?: unknown;
    browserToolPolicy?: unknown;
    browserProfileId?: string;
  };
  toolMode?: "read_only" | "auto";
}): {
  policy: BrowserUnattendedPolicy;
  effectivePolicy: EffectiveBrowserPolicy;
  profileId?: string;
} {
  const requested =
    args.body.policy === undefined
      ? undefined
      : browserSessionPolicySchema.parse(args.body.policy);
  const host = args.hostRuntimeConfig;
  if (args.stored && args.hostId !== args.stored.hostId)
    throw new SessionBrowserError(
      "BROWSER_POLICY_FIXED",
      400,
      "The browser's host authority is fixed.",
    );
  if (
    (args.hostId || args.stored?.hostId) &&
    (!host ||
      !Array.isArray(host.builtInToolIds) ||
      !host.builtInToolIds.includes("browser"))
  )
    throw new SessionBrowserError(
      "BROWSER_NOT_AVAILABLE",
      422,
      "The host does not advertise browser tools.",
    );
  const ceiling =
    host?.browserToolPolicy === undefined
      ? undefined
      : parseBrowserToolPolicy(host.browserToolPolicy);
  if (host?.browserToolPolicy !== undefined && !ceiling)
    throw new SessionBrowserError(
      "BROWSER_NOT_AVAILABLE",
      422,
      "The host browser policy is invalid.",
    );
  if (
    requested &&
    args.stored &&
    canonical(requested) !== canonical(args.stored.policy)
  )
    throw new SessionBrowserError(
      "BROWSER_POLICY_FIXED",
      400,
      "The browser policy is fixed; omit it to reuse the stored grant.",
    );
  if (
    args.stored &&
    args.body.profileId !== undefined &&
    args.body.profileId !== args.stored.profileId
  )
    throw new SessionBrowserError(
      "BROWSER_PROFILE_FIXED",
      400,
      "The browser profile is fixed.",
    );
  if (
    requested &&
    ceiling &&
    !browserPolicyWithin(
      compileBrowserPolicy(requested),
      compileBrowserPolicy(ceiling),
    )
  )
    throw new SessionBrowserError(
      "BROWSER_POLICY_WIDENS_HOST",
      400,
      "The requested policy exceeds the host policy.",
    );
  const policy = args.stored?.policy ?? requested ?? ceiling;
  if (!policy)
    throw new SessionBrowserError(
      "BROWSER_POLICY_REQUIRED",
      400,
      "Declare a browser policy when opening the session browser.",
    );
  const profileId = args.stored
    ? args.stored.profileId
    : args.body.profileId ?? host?.browserProfileId;
  return {
    policy,
    effectivePolicy: intersectBrowserPolicies(
      compileBrowserPolicy(policy),
      ...(ceiling ? [compileBrowserPolicy(ceiling)] : []),
      ...(args.toolMode === "read_only"
        ? [compileBrowserPolicy({ mode: "read_only" })]
        : []),
    ),
    ...(profileId ? { profileId } : {}),
  };
}
export async function getConversationBrowser(args: {
  bearer: string;
  projectId: string;
  wireUuid: string;
  signal?: AbortSignal;
}): Promise<ConversationBrowser | null> {
  const response = await new BrowserSessionService().agentRequest<{
    session: ConversationBrowser | null;
  }>("get_conversation", {
    bearer: args.bearer,
    projectId: args.projectId,
    signal: args.signal,
    body: { projectId: args.projectId, conversationId: args.wireUuid },
  });
  return response.session;
}
export async function openConversationBrowser(args: {
  bearer: string;
  projectId: string;
  wireUuid: string;
  policy: BrowserUnattendedPolicy;
  profileId?: string;
  hostId?: string;
  environmentId?: string;
  signal?: AbortSignal;
}): Promise<ConversationBrowser> {
  const response = await new BrowserSessionService().agentRequest<{
    session: ConversationBrowser;
  }>("open_conversation", {
    bearer: args.bearer,
    projectId: args.projectId,
    signal: args.signal,
    body: {
      projectId: args.projectId,
      conversationId: args.wireUuid,
      policy: args.policy,
      profileId: args.profileId,
      hostId: args.hostId,
      environmentId: args.environmentId,
    },
  });
  return response.session;
}
export async function provisionConversationBrowser(args: {
  bearer: string;
  projectId: string;
  wireUuid: string;
  hostId?: string;
  profileId?: string;
  signal: AbortSignal;
  onNotice?: (notice: string) => void;
}) {
  try {
    return await ensureHostedConversationSession({
      bearer: args.bearer,
      projectId: args.projectId,
      logicalSessionId: args.wireUuid,
      ownerKind: "conversation",
      contextMode: "persistent",
      hostId: args.hostId,
      browserProfileId: args.profileId,
      onNotice: args.onNotice,
      signal: AbortSignal.any([args.signal, AbortSignal.timeout(120_000)]),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (
      error instanceof BrowserAdmissionError &&
      error.refusal.code === "user_desktop_cap"
    )
      throw new SessionBrowserError(
        "BROWSER_CAP_EXCEEDED",
        409,
        message,
        error.refusal.retryAfterMs ?? 60_000,
        error.refusal.limit,
      );
    if (message.includes("user_desktop_cap"))
      throw new SessionBrowserError(
        "BROWSER_CAP_EXCEEDED",
        409,
        message,
        60_000,
      );
    if (/capacity|timeout|timed out|aborted/i.test(message))
      throw new SessionBrowserError("BROWSER_NOT_READY", 503, message, 60_000);
    throw new SessionBrowserError("BROWSER_NOT_AVAILABLE", 422, message);
  }
}
