import { describe, expect, it } from "vitest";
import { AnswerCache } from "../limits.js";

describe("AnswerCache", () => {
  it("keeps an answer for its time and never past a shorter bound", () => {
    let now = 0;
    const cache = new AnswerCache<string>(60_000, () => now);
    cache.set("long", "answer");
    cache.set("short", "answer", 5_000);
    now = 4_999;
    expect(cache.get("short")).toBe("answer");
    now = 5_000;
    expect(cache.get("short")).toBeUndefined();
    expect(cache.get("long")).toBe("answer");
    now = 60_000;
    expect(cache.get("long")).toBeUndefined();
  });
});
