import { describe, expect, it } from "vitest";
import {
  blockedByDetails,
  blockedByMessage,
  stoppedAnsweringMessage,
} from "../src/conformance-blocked.js";

describe("blocked checks name the check that broke first", () => {
  it("names the blocking check", () => {
    expect(blockedByMessage("Server Initialize")).toBe(
      'Skipped because "Server Initialize" failed first.'
    );
    expect(blockedByDetails("server-initialize")).toEqual({
      blockedBy: "server-initialize",
    });
  });

  it("names the checks that timed out", () => {
    expect(stoppedAnsweringMessage(["Ping", "Tools List"])).toBe(
      'Skipped because the server stopped responding ("Ping" and "Tools List" timed out).'
    );
    expect(stoppedAnsweringMessage(["A", "B", "C"])).toBe(
      'Skipped because the server stopped responding ("A", "B" and "C" timed out).'
    );
    expect(stoppedAnsweringMessage([])).toBe(
      "Skipped because the server stopped responding."
    );
  });
});
