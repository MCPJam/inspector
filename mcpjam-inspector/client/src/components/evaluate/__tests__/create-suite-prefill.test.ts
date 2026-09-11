import { describe, expect, it } from "vitest";
import {
  DEFAULT_CREATE_SUITE_NAME,
  nextUnusedSuiteName,
  pickServerAttachmentIdForServer,
  seedCreateSuiteName,
} from "../create-suite-prefill";

describe("nextUnusedSuiteName", () => {
  it("starts at Suite 1 when nothing is numbered", () => {
    expect(nextUnusedSuiteName()).toBe("Suite 1");
    expect(nextUnusedSuiteName([])).toBe("Suite 1");
    expect(nextUnusedSuiteName(["Checkout", "Untitled suite"])).toBe(
      "Suite 1",
    );
    expect(DEFAULT_CREATE_SUITE_NAME).toBe("Suite 1");
  });

  it("increments from the highest exact Suite N", () => {
    expect(nextUnusedSuiteName(["Suite 1"])).toBe("Suite 2");
    expect(nextUnusedSuiteName(["Suite 1", "Suite 2"])).toBe("Suite 3");
    expect(nextUnusedSuiteName(["Suite 2", "Suite 1", "Checkout"])).toBe(
      "Suite 3",
    );
    expect(nextUnusedSuiteName(["Suite 10"])).toBe("Suite 11");
    expect(nextUnusedSuiteName(["Suite 1", "Suite 3"])).toBe("Suite 4");
  });

  it("ignores names that are not an exact Suite N", () => {
    expect(
      nextUnusedSuiteName([
        "Suite 1 extra",
        "suite 1",
        "Suite 1 ",
        "My Suite 1",
        "Suite",
      ]),
    ).toBe("Suite 1");
  });
});

describe("seedCreateSuiteName", () => {
  it("uses the next unused Suite N when there is no initialName prefill", () => {
    expect(seedCreateSuiteName()).toBe("Suite 1");
    expect(seedCreateSuiteName(null)).toBe("Suite 1");
    expect(seedCreateSuiteName("")).toBe("Suite 1");
    expect(seedCreateSuiteName("   ")).toBe("Suite 1");
    expect(seedCreateSuiteName(null, ["Suite 1", "Suite 2"])).toBe("Suite 3");
  });

  it("lets empty-hero / URL prefill override the numbered default", () => {
    expect(seedCreateSuiteName("checkout-server")).toBe("checkout-server");
    expect(seedCreateSuiteName("checkout-server", ["Suite 1"])).toBe(
      "checkout-server",
    );
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
