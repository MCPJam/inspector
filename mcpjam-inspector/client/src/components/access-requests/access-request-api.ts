import { makeFunctionReference } from "convex/server";

export type AccessRequestStatus = "pending" | "approved" | "declined";
export type AccessDecision = "approve" | "decline";

export type AccessRequest = {
  requestId: string;
  status: AccessRequestStatus;
  requestedAt: number;
  decidedAt: number | null;
  project: { id: string; name: string };
  organizationId: string;
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
