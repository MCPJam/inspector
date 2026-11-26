import type { AccessRequest, DecisionResult } from "./access-request-api";

/**
 * What the approver reads once a request has an answer. `billing` is set when
 * the next step is in organization billing, so the page links there.
 */
export type Outcome = { title: string; body: string; billing: boolean };

export function requesterLabel(request: AccessRequest): string {
  return request.requester.name ?? request.requester.email;
}

/** The outcome of a decision this approver just made. */
export function outcomeOfDecision(
  request: AccessRequest,
  result: DecisionResult,
): Outcome {
  const who = requesterLabel(request);
  const project = request.project.name;
  if (result.status === "declined") {
    // Declining one request does not take away access from another approval.
    return {
      billing: false,
      title: "Request declined",
      body:
        result.access === "granted"
          ? `You declined this request. ${who} still has access to ${project}.`
          : "You declined this request.",
    };
  }
  if (result.access === "pending" && result.seatPaymentIntentId) {
    return {
      billing: true,
      title: "Approved, waiting on a seat payment",
      body: `An organization owner has to finish the seat payment in organization billing. ${who} gets access to ${project} after that.`,
    };
  }
  if (result.access === "pending") {
    // The backend does not say what is still open (a seat payment started
    // earlier, or an invitation), so name both and keep the billing link. As
    // above, the payment is an organization owner's step: this approver may
    // only own the project.
    return {
      billing: true,
      title: "Approved, access not active yet",
      body: `${who} gets access to ${project} after an organization owner finishes an open seat payment in organization billing, or after they accept the invitation to your organization.`,
    };
  }
  return {
    billing: false,
    title: "Access granted",
    body: result.addedToOrg
      ? `${who} joined your organization as a guest and can edit ${project}.`
      : `${who} can now edit ${project}.`,
  };
}

/** A request someone already answered before this page opened. */
export function outcomeOfEarlierDecision(request: AccessRequest): Outcome {
  const who = requesterLabel(request);
  const when = request.decidedAt
    ? ` on ${new Date(request.decidedAt).toLocaleDateString()}`
    : "";
  return request.status === "approved"
    ? {
        billing: false,
        title: "Request already approved",
        body: `${who} was approved for ${request.project.name}${when}.`,
      }
    : {
        billing: false,
        title: "Request already declined",
        body: `${who} was declined for ${request.project.name}${when}.`,
      };
}

/** Refusals the page answers with a next step instead of a toast. */
export function outcomeOfRefusal(code: string | null): Outcome | null {
  if (code === "SEAT_PAYMENT_OWNER_REQUIRED") {
    return {
      billing: true,
      title: "An organization owner has to approve this",
      body: "Approving adds a paid seat. Ask an organization owner to approve this request, or to add the seat in organization billing.",
    };
  }
  if (code === "SEAT_PAYMENT_IN_PROGRESS") {
    return {
      billing: true,
      title: "Another seat payment is open",
      body: "Finish or cancel the open seat payment in organization billing, then approve this request.",
    };
  }
  return null;
}
