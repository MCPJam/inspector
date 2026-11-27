import { ConvexError } from "convex/values";
import { makeFunctionReference } from "convex/server";

export type AccessRequestStatus = "pending" | "approved" | "declined";
export type AccessDecision = "approve" | "decline";

export type AccessRequest = {
  requestId: string;
  status: AccessRequestStatus;
  requestedAt: number;
  decidedAt: number | null;
  /** Null when the request asks to join the organization itself. */
  project: { id: string; name: string } | null;
  organizationId: string;
  organizationName: string;
  requester: { name: string | null; email: string };
  requesterInOrganization: boolean;
};

export type DecisionResult = {
  status: AccessRequestStatus;
  access: "granted" | "pending";
  addedToOrg?: boolean;
  seatPaymentIntentId?: string | null;
};

export const requestProjectAccessRef = makeFunctionReference<
  "mutation",
  { projectId: string },
  { status: "sent" }
>("projectAccessRequests:requestProjectAccess");

export const getProjectAccessRequestRef = makeFunctionReference<
  "query",
  { requestId: string },
  AccessRequest | null
>("projectAccessRequests:getProjectAccessRequest");

export const decideProjectAccessRequestRef = makeFunctionReference<
  "mutation",
  { requestId: string; decision: AccessDecision },
  DecisionResult
>("projectAccessRequests:decideProjectAccessRequest");

export function accessRequestPath(requestId: string): string {
  return `/access-requests/${encodeURIComponent(requestId)}`;
}

/** The `code` a backend `ConvexError` carries, when it carries one. */
export function convexErrorCode(error: unknown): string | null {
  if (!(error instanceof ConvexError)) return null;
  const data: unknown = error.data;
  if (!data || typeof data !== "object" || !("code" in data)) return null;
  return typeof data.code === "string" ? data.code : null;
}
