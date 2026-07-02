import { describe, expect, it } from "vitest";
import {
  isAppToolAlias,
  isClientFulfilledToolName,
  isUiToolName,
} from "../client-fulfilled-tools";

describe("client-fulfilled tool names", () => {
  it("matches app aliases", () => {
    expect(isAppToolAlias("app_abcd1234")).toBe(true);
    expect(isAppToolAlias("app_ABCD1234")).toBe(true); // case-insensitive
    expect(isAppToolAlias("app_abcd123")).toBe(false); // 7 hex
    expect(isAppToolAlias("app_abcd12345")).toBe(false); // 9 hex
    expect(isAppToolAlias("ui_navigate")).toBe(false);
  });

  it("matches curated ui_ names", () => {
    expect(isUiToolName("ui_navigate")).toBe(true);
    expect(isUiToolName("ui_set_app_context")).toBe(true);
    expect(isUiToolName("ui_a")).toBe(true);
    expect(isUiToolName(`ui_${"a".repeat(61)}`)).toBe(true); // 64 chars total
    expect(isUiToolName(`ui_${"a".repeat(62)}`)).toBe(false); // 65 chars
    expect(isUiToolName("ui_")).toBe(false); // nothing after prefix
    expect(isUiToolName("ui__leading_underscore")).toBe(false);
    expect(isUiToolName("ui_Navigate")).toBe(false); // uppercase
    expect(isUiToolName("ui_with-hyphen")).toBe(false);
    expect(isUiToolName("uinavigate")).toBe(false);
    expect(isUiToolName("app_abcd1234")).toBe(false);
  });

  it("isClientFulfilledToolName is the union of both namespaces", () => {
    expect(isClientFulfilledToolName("app_abcd1234")).toBe(true);
    expect(isClientFulfilledToolName("ui_navigate")).toBe(true);
    expect(isClientFulfilledToolName("regular_tool")).toBe(false);
    expect(isClientFulfilledToolName("ui-navigate")).toBe(false);
  });
});
