import { describe, expect, it } from "vitest";
import { buildSenderAvatarResolver } from "../sender-avatar";

function makeMap(
  entries: Array<[string, { imageUrl: string; name: string }]>,
) {
  return new Map(entries);
}

describe("buildSenderAvatarResolver", () => {
  it("returns the persisted sender when present", () => {
    const resolve = buildSenderAvatarResolver({
      profileByUserId: makeMap([
        ["u-alice", { imageUrl: "https://x/alice.png", name: "Alice" }],
        ["u-bob", { imageUrl: "  ", name: "Bob" }],
      ]),
      fallbackOwnerUserId: "u-owner",
    });

    expect(resolve("u-alice")).toEqual({
      status: "show",
      displayName: "Alice",
      imageUrl: "https://x/alice.png",
    });

    // Whitespace-only imageUrl is dropped so AvatarImage doesn't crash on
    // an empty src; the renderer falls through to initials.
    expect(resolve("u-bob")).toEqual({
      status: "show",
      displayName: "Bob",
      imageUrl: undefined,
    });
  });

  it("falls back to owner when senderUserId is absent", () => {
    const resolve = buildSenderAvatarResolver({
      profileByUserId: makeMap([
        ["u-owner", { imageUrl: "https://x/owner.png", name: "Owner" }],
      ]),
      fallbackOwnerUserId: "u-owner",
    });

    expect(resolve(undefined)).toEqual({
      status: "show",
      displayName: "Owner",
      imageUrl: "https://x/owner.png",
    });
    expect(resolve("")).toEqual({
      status: "show",
      displayName: "Owner",
      imageUrl: "https://x/owner.png",
    });
  });

  it("returns generic for an unknown userId (former member)", () => {
    const resolve = buildSenderAvatarResolver({
      profileByUserId: makeMap([
        ["u-owner", { imageUrl: "https://x/owner.png", name: "Owner" }],
      ]),
      fallbackOwnerUserId: "u-owner",
    });

    // Unknown sender id and an owner that *is* still around: we resolve to
    // the owner only when the sender is missing entirely. A former member
    // (sender id no longer in the map) becomes "generic" rather than being
    // silently misattributed to the owner.
    expect(resolve("u-former")).toEqual({ status: "generic" });
  });

  it("returns generic when neither sender nor fallback resolves", () => {
    const resolve = buildSenderAvatarResolver({
      profileByUserId: makeMap([]),
      fallbackOwnerUserId: null,
    });
    expect(resolve(undefined)).toEqual({ status: "generic" });
    expect(resolve("u-anyone")).toEqual({ status: "generic" });
  });
});
