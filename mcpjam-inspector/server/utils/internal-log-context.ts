import type { RequestLogContext } from "./log-events.js";

/**
 * Server-only logging context returned by Convex authorize endpoints
 * (`/web/authorize-batch` and `/web/authorize-batch-local`). Optional during
 * rollout — every consumer must tolerate missing fields.
 *
 * NEVER forward this to the browser. Both producers (`routes/web/auth.ts`
 * for hosted, `utils/local-server-resolver.ts` for local) strip it before
 * the response leaves the server. Centralizing the shape here so a new
 * field added on the Convex side only needs to be plumbed in one place.
 */
export type InternalLogContext = {
  authType?: "signedIn" | "guest";
  userId?: string | null;
  userExternalId?: string | null;
  guestExternalId?: string | null;
  emailDomain?: string | null;
  orgId?: string | null;
  orgPlan?: string | null;
  orgSeatQuantity?: number | null;
  orgCreatedBy?: string | null;
  projectId?: string | null;
  projectRole?:
    | "owner"
    | "admin"
    | "member"
    | "guest"
    | "editor"
    | "chat"
    | null;
  accessLevel?: "project_member" | "shared_chat" | null;
  serverId?: string | null;
  serverTransport?: "stdio" | "http" | null;
  chatboxId?: string | null;
  surface?: "preview" | "share_link" | null;
};

/**
 * Lift an `InternalLogContext` into the partial shape `setRequestLogContext`
 * accepts. Every field defaults to `null` when missing so the request log
 * line has a stable shape.
 */
export function mapInternalToRequestContext(
  ctx: InternalLogContext,
): Partial<RequestLogContext> {
  return {
    // `RequestLogContext.authType` is required-non-null. Omit the field when
    // the upstream payload didn't include one rather than poking `null` into
    // a slot that's typed `AuthType`.
    ...(ctx.authType ? { authType: ctx.authType } : {}),
    userId: ctx.userId ?? null,
    userExternalId: ctx.userExternalId ?? null,
    guestExternalId: ctx.guestExternalId ?? null,
    emailDomain: ctx.emailDomain ?? null,
    orgId: ctx.orgId ?? null,
    orgPlan: ctx.orgPlan ?? null,
    orgSeatQuantity: ctx.orgSeatQuantity ?? null,
    orgCreatedBy: ctx.orgCreatedBy ?? null,
    projectId: ctx.projectId ?? null,
    projectRole: ctx.projectRole ?? null,
    accessLevel: ctx.accessLevel ?? null,
    serverId: ctx.serverId ?? null,
    serverTransport: ctx.serverTransport ?? null,
    chatboxId: ctx.chatboxId ?? null,
    surface: ctx.surface ?? null,
  };
}
