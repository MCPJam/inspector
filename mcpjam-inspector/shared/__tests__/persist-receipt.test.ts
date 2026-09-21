import { describe, expect, it } from "vitest";
import {
  PERSIST_RECEIPT_PART_TYPE,
  isPersistReceiptDataPart,
} from "../persist-receipt";

describe("isPersistReceiptDataPart", () => {
  const valid = {
    type: PERSIST_RECEIPT_PART_TYPE,
    data: { outcome: "saved", chatSessionId: "session-1", version: 3 },
  };

  it("accepts every outcome the server can report", () => {
    for (const outcome of [
      "saved",
      "duplicate",
      "skipped",
      "conflict",
      "failed",
    ]) {
      expect(
        isPersistReceiptDataPart({
          type: PERSIST_RECEIPT_PART_TYPE,
          data: { outcome, chatSessionId: "session-1" },
        })
      ).toBe(true);
    }
  });

  it("accepts a full receipt", () => {
    expect(isPersistReceiptDataPart(valid)).toBe(true);
  });

  it("rejects a receipt with no chatSessionId", () => {
    // Without it the client cannot tell whether the receipt describes the
    // thread currently on screen, and an unattributable receipt is worse than
    // none — it could sync a baseline onto the wrong conversation.
    expect(
      isPersistReceiptDataPart({
        type: PERSIST_RECEIPT_PART_TYPE,
        data: { outcome: "saved", version: 3 },
      })
    ).toBe(false);
    expect(
      isPersistReceiptDataPart({
        type: PERSIST_RECEIPT_PART_TYPE,
        data: { outcome: "saved", chatSessionId: "" },
      })
    ).toBe(false);
  });

  it("rejects an unknown outcome", () => {
    expect(
      isPersistReceiptDataPart({
        type: PERSIST_RECEIPT_PART_TYPE,
        data: { outcome: "maybe", chatSessionId: "session-1" },
      })
    ).toBe(false);
  });

  it("rejects other part types and non-objects", () => {
    expect(
      isPersistReceiptDataPart({ type: "data-harness-session", data: {} })
    ).toBe(false);
    expect(isPersistReceiptDataPart(null)).toBe(false);
    expect(isPersistReceiptDataPart("data-persist-receipt")).toBe(false);
    expect(isPersistReceiptDataPart({ type: PERSIST_RECEIPT_PART_TYPE })).toBe(
      false
    );
  });
});
