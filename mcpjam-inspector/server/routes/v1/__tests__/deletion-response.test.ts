import { expect, it } from "vitest";
import { deletionResponse } from "../deletion-response.js";
it("preserves accepted cleanup without claiming the object has gone", () => {
  expect(
    deletionResponse({
      accepted: true,
      requestId: "r1",
      state: "accepted",
      deleted: false,
    }),
  ).toEqual({
    accepted: true,
    requestId: "r1",
    state: "accepted",
    deleted: false,
  });
});
it("rejects a malformed acceptance instead of converting it to deleted", () => {
  expect(() => deletionResponse({ accepted: true, requestId: "r1" })).toThrow();
});
it("preserves synchronous legacy deletion responses", () => {
  expect(deletionResponse({ success: true })).toEqual({ deleted: true });
});
