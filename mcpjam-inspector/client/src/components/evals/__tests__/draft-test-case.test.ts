import { describe, expect, it } from "vitest";
import {
  draftTestCaseId,
  isDraftTestCaseId,
  parseDraftTestCaseId,
} from "../draft-test-case";

describe("draft-test-case", () => {
  it("round-trips prompt and record sentinels", () => {
    expect(draftTestCaseId("prompt")).toBe("draft:prompt");
    expect(draftTestCaseId("record")).toBe("draft:record");
    expect(parseDraftTestCaseId("draft:prompt")).toBe("prompt");
    expect(parseDraftTestCaseId("draft:record")).toBe("record");
    expect(isDraftTestCaseId("draft:record")).toBe(true);
  });

  it("rejects unknown or real ids", () => {
    expect(parseDraftTestCaseId("draft:widget")).toBeNull();
    expect(parseDraftTestCaseId("case-1")).toBeNull();
    expect(parseDraftTestCaseId(null)).toBeNull();
    expect(isDraftTestCaseId("draft:")).toBe(false);
  });
});
