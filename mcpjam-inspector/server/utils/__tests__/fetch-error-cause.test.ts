import { describe, expect, it } from "vitest";
import { isFetchConnectionFailure } from "../fetch-error-cause.js";

describe("isFetchConnectionFailure", () => {
  it("matches undici's fetch failed", () => {
    expect(
      isFetchConnectionFailure(
        new TypeError("fetch failed", { cause: { code: "ENOTFOUND" } }),
      ),
    ).toBe(true);
  });

  it.each(["UND_ERR_SOCKET", "ECONNRESET"])(
    "matches a body read terminated by %s",
    (code) => {
      expect(
        isFetchConnectionFailure(
          new TypeError("terminated", { cause: { code } }),
        ),
      ).toBe(true);
    },
  );

  it("does not match a terminated read with no socket cause", () => {
    expect(isFetchConnectionFailure(new TypeError("terminated"))).toBe(false);
  });

  it("does not match a URL parse failure", () => {
    expect(
      isFetchConnectionFailure(new TypeError("Failed to parse URL from x")),
    ).toBe(false);
  });
});
