import { describe, expect, it } from "vitest";
import {
  hostFocusTabToVerifyParam,
  parseHostVerifyTabParam,
} from "../host-verify-deep-link";

describe("host verify deep link", () => {
  it("opens a client on its Events tab", () => {
    expect(hostFocusTabToVerifyParam("events")).toBe("events");
    expect(parseHostVerifyTabParam("?hostTab=events")).toBe("events");
  });
});
