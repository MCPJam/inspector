import { describe, expect, it } from "vitest";
import {
  isSandboxNoticeDataPart,
  isSandboxNoticeReason,
  SANDBOX_NOTICE_DATA_PART_TYPE,
} from "../sandbox-notice";

describe("sandbox notice data part", () => {
  it("accepts each known reason", () => {
    for (const reason of ["sandbox_reset", "stale_image"]) {
      expect(
        isSandboxNoticeDataPart({
          type: SANDBOX_NOTICE_DATA_PART_TYPE,
          data: { reason },
        })
      ).toBe(true);
    }
  });

  it("rejects an unknown reason rather than rendering an empty toast", () => {
    // The client keys its copy off the reason. An unrecognized value from a
    // newer backend must fall out here, not surface as `undefined` text.
    expect(
      isSandboxNoticeDataPart({
        type: SANDBOX_NOTICE_DATA_PART_TYPE,
        data: { reason: "invented_later" },
      })
    ).toBe(false);
    expect(isSandboxNoticeReason("invented_later")).toBe(false);
  });

  it("rejects the wrong part type and malformed envelopes", () => {
    expect(
      isSandboxNoticeDataPart({
        type: "data-harness-reset",
        data: { reason: "sandbox_reset" },
      })
    ).toBe(false);
    expect(
      isSandboxNoticeDataPart({ type: SANDBOX_NOTICE_DATA_PART_TYPE })
    ).toBe(false);
    expect(isSandboxNoticeDataPart(null)).toBe(false);
    expect(isSandboxNoticeDataPart("sandbox_reset")).toBe(false);
  });
});
