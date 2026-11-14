import { describe, expect, it } from "vitest";
import { SHARE_CARD_FONT_FACES } from "@/shared/conformance-share-card";
import { SHARE_CARD_FONT_URLS } from "../share-card-fonts";

describe("share card fonts", () => {
  it("bundles every face the card draws with", () => {
    for (const { file } of SHARE_CARD_FONT_FACES) {
      expect(SHARE_CARD_FONT_URLS[file], file).toBeTruthy();
    }
    expect(Object.keys(SHARE_CARD_FONT_URLS)).toHaveLength(
      SHARE_CARD_FONT_FACES.length,
    );
  });
});
