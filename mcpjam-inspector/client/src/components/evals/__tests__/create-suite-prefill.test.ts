import { describe, expect, it } from "vitest";
import {
  DEFAULT_CREATE_SUITE_NAME,
  pickServerAttachmentIdForServer,
  seedCreateSuiteName,
} from "../create-suite-prefill";

describe("seedCreateSuiteName", () => {
  it("uses the default when there is no initialName prefill", () => {
    expect(seedCreateSuiteName()).toBe(DEFAULT_CREATE_SUITE_NAME);
    expect(seedCreateSuiteName(null)).toBe(DEFAULT_CREATE_SUITE_NAME);
    expect(seedCreateSuiteName("")).toBe(DEFAULT_CREATE_SUITE_NAME);
    expect(seedCreateSuiteName("   ")).toBe(DEFAULT_CREATE_SUITE_NAME);
  });

  it("lets empty-hero / URL prefill override the default", () => {
    expect(seedCreateSuiteName("checkout-server")).toBe("checkout-server");
  });
});

describe("pickServerAttachmentIdForServer", () => {
  it("prefers an exact single-server group over a larger group that also contains it", () => {
    expect(
      pickServerAttachmentIdForServer(
        [
          { _id: "group-all", serverIds: ["srv-a", "srv-b"] },
          { _id: "group-a", serverIds: ["srv-a"] },
        ],
        "srv-a",
      ),
    ).toBe("group-a");
  });

  it("falls back to the smallest group that includes the server", () => {
    expect(
      pickServerAttachmentIdForServer(
        [
          { _id: "group-wide", serverIds: ["srv-a", "srv-b", "srv-c"] },
          { _id: "group-pair", serverIds: ["srv-a", "srv-b"] },
        ],
        "srv-a",
      ),
    ).toBe("group-pair");
  });

  it("returns null when no group contains the server", () => {
    expect(
      pickServerAttachmentIdForServer(
        [{ _id: "group-b", serverIds: ["srv-b"] }],
        "srv-a",
      ),
    ).toBeNull();
  });
});
