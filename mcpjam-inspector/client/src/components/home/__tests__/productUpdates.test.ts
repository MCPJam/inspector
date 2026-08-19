import { describe, expect, it } from "vitest";
import { PRODUCT_UPDATES } from "../productUpdates";

describe("PRODUCT_UPDATES", () => {
  it("contains each update slug once", () => {
    const slugs = PRODUCT_UPDATES.map((entry) => entry.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
  });

  it("keeps the XAA GA video as an uncontrolled looping demo", () => {
    expect(
      PRODUCT_UPDATES.find((entry) => entry.slug === "xaa-debugger-ga")
    ).toMatchObject({
      hideControls: true,
      previewVideoUrl:
        "https://outstanding-fennec-304.convex.cloud/api/storage/b3a2592b-ab5f-42df-ad2c-db4fa2f39172",
    });
  });
});
