import { beforeEach, describe, expect, it, vi } from "vitest";

const guest = vi.hoisted(() => ({
  result: { valid: false } as { valid: boolean; guestId?: string },
  throws: false,
}));
vi.mock("../../../services/guest-token-verifier.js", () => ({
  validateGuestToken: (_token: string) => {
    if (guest.throws) throw new Error("guest keys not initialized");
    return guest.result;
  },
}));

import { isGuestChatRequest } from "../local-engine-request.js";

describe("isGuestChatRequest — local-engine boundary", () => {
  beforeEach(() => {
    guest.result = { valid: false };
    guest.throws = false;
  });

  it("no Authorization ⇒ guest (anonymous; the route mints a bearer later)", () => {
    expect(isGuestChatRequest(undefined)).toBe(true);
    expect(isGuestChatRequest("")).toBe(true);
    expect(isGuestChatRequest("Bearer ")).toBe(true);
  });

  it("a member bearer (not a valid guest token) ⇒ NOT guest", () => {
    guest.result = { valid: false };
    expect(isGuestChatRequest("Bearer member-workos-jwt")).toBe(false);
  });

  it("a valid GUEST bearer ⇒ guest (the signed-out-with-stale-token case)", () => {
    guest.result = { valid: true, guestId: "g-1" };
    expect(isGuestChatRequest("Bearer guest-jwt")).toBe(true);
  });

  it("keys uninitialized (throws) ⇒ a present bearer is treated as a member", () => {
    // Guest tokens can't have been minted, so a present bearer is a member.
    guest.throws = true;
    expect(isGuestChatRequest("Bearer some-token")).toBe(false);
  });
});
