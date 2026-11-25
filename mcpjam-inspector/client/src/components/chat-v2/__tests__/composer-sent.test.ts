import { describe, expect, it } from "vitest";
import { remainingText, withoutSent } from "../composer-sent";

describe("remainingText", () => {
  it.each([
    ["the box still holds what was sent", "first", "first", ""],
    ["text was added after a space", "first plus more", "first", "plus more"],
    ["text was added on a new line", "first\nsecond", "first", "second"],
    ["the sent text ends in a space", "first more", "first ", "more"],
    ["the last sent word was continued", "testing x", "test", "testing x"],
    ["the draft was edited", "frist", "first", "frist"],
    ["the send had no text", "  typed meanwhile", "", "typed meanwhile"],
    ["the box is empty", "", "first", ""],
  ])("when %s", (_case, current, sent, left) => {
    expect(remainingText(current, sent)).toBe(left);
  });
});

describe("withoutSent", () => {
  it("drops the items the send carried and keeps the ones added since", () => {
    const sent = { id: "a" };
    const twin = { id: "a" };
    const added = { id: "b" };

    expect(withoutSent([sent, twin, added], [sent])).toEqual([twin, added]);
    expect(withoutSent([sent, twin, added], [sent])[0]).toBe(twin);
  });
});
