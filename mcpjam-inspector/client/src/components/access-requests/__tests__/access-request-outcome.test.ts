import { describe, expect, it } from "vitest";
import type { AccessRequest } from "../access-request-api";
import {
  outcomeOfDecision,
  outcomeOfEarlierDecision,
  outcomeOfJoinDecision,
  requestTargetName,
} from "../access-request-outcome";

const PROJECT_REQUEST: AccessRequest = {
  requestId: "req_1",
  status: "pending",
  requestedAt: 1,
  decidedAt: null,
  project: { id: "proj_1", name: "Support bot" },
  organizationId: "org_acme",
  organizationName: "Acme",
  requester: { name: "Jo Chen", email: "jo@acme.com" },
  requesterInOrganization: false,
};
const JOIN_REQUEST: AccessRequest = { ...PROJECT_REQUEST, project: null };

describe("organization join outcomes", () => {
  it("names the organization when the request has no project", () => {
    expect(requestTargetName(JOIN_REQUEST)).toBe("Acme");
    expect(requestTargetName(PROJECT_REQUEST)).toBe("Support bot");
  });

  it("words each decision for joining the organization", () => {
    expect(
      outcomeOfJoinDecision("Jo Chen", "Acme", {
        status: "approved",
        access: "granted",
      }),
    ).toEqual({
      billing: false,
      title: "Request approved",
      body: "Jo Chen is now a member of Acme.",
    });
    expect(
      outcomeOfJoinDecision("Jo Chen", "Acme", {
        status: "approved",
        access: "pending",
        seatPaymentIntentId: "seat_1",
      }),
    ).toEqual({
      billing: true,
      title: "Approved, waiting on a seat payment",
      body: "An organization owner has to finish the seat payment in organization billing. Jo Chen joins Acme after that.",
    });
    expect(
      outcomeOfJoinDecision("Jo Chen", "Acme", {
        status: "approved",
        access: "pending",
      }),
    ).toEqual({
      billing: false,
      title: "Approved, waiting on the invitation",
      body: "Jo Chen joins Acme once they accept the invitation.",
    });
    expect(
      outcomeOfJoinDecision("Jo Chen", "Acme", {
        status: "declined",
        access: "pending",
      }),
    ).toEqual({
      billing: false,
      title: "Request declined",
      body: "Jo Chen was not added to Acme.",
    });
  });

  it("uses the join wording for a decision on the approve page", () => {
    expect(
      outcomeOfDecision(JOIN_REQUEST, { status: "approved", access: "granted" })
        .body,
    ).toBe("Jo Chen is now a member of Acme.");
  });

  it("words an earlier decision on a join request", () => {
    const decidedAt = Date.UTC(2026, 10, 14, 12);
    const on = ` on ${new Date(decidedAt).toLocaleDateString()}`;
    expect(
      outcomeOfEarlierDecision({
        ...JOIN_REQUEST,
        status: "approved",
        decidedAt,
      }),
    ).toEqual({
      billing: false,
      title: "Request already approved",
      body: `Jo Chen was approved to join Acme${on}.`,
    });
    expect(
      outcomeOfEarlierDecision({ ...JOIN_REQUEST, status: "declined" }),
    ).toEqual({
      billing: false,
      title: "Request already declined",
      body: "Jo Chen's request to join Acme was declined.",
    });
  });

  it("keeps the project wording for project requests", () => {
    expect(
      outcomeOfDecision(PROJECT_REQUEST, {
        status: "approved",
        access: "granted",
        addedToOrg: true,
      }),
    ).toEqual({
      billing: false,
      title: "Access granted",
      body: "Jo Chen joined your organization as a guest and can edit Support bot.",
    });
    expect(
      outcomeOfDecision(PROJECT_REQUEST, {
        status: "declined",
        access: "pending",
      }).body,
    ).toBe("Jo Chen does not have access to Support bot.");
    expect(
      outcomeOfEarlierDecision({ ...PROJECT_REQUEST, status: "declined" }).body,
    ).toBe("Jo Chen was declined for Support bot.");
  });
});
