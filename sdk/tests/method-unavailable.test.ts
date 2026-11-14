import { describe, expect, it } from "vitest";
import { SdkError, SdkErrorCode } from "@modelcontextprotocol/client";
import { isMethodUnavailableError } from "../src/mcp-client-manager/error-utils";
describe("method absence classification", () => {
  it("does not hide malformed or unhandled modern results as an empty catalog", () => {
    for (const type of ["tools/list", "input_required"]) {
      const error = new SdkError(
        SdkErrorCode.UnsupportedResultType,
        `Unsupported result type '${type}' for tools/list`
      );
      expect(isMethodUnavailableError(error, "tools/list")).toBe(false);
    }
    expect(
      isMethodUnavailableError(
        new Error("Unsupported result type 'future' for tools/list"),
        "tools/list"
      )
    ).toBe(false);
    expect(
      isMethodUnavailableError(
        new SdkError(
          SdkErrorCode.InvalidResult,
          "Unsupported field in tools/list result"
        ),
        "tools/list"
      )
    ).toBe(false);
  });
  it("keeps genuine unsupported-method handling", () => {
    expect(
      isMethodUnavailableError(
        new Error("Method not found: tools/list"),
        "tools/list"
      )
    ).toBe(true);
    expect(
      isMethodUnavailableError(
        new Error("Server does not support resources/list"),
        "resources/list"
      )
    ).toBe(true);
  });
});
