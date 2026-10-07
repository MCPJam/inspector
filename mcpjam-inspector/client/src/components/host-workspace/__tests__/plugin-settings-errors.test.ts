import { describe, expect, it } from "vitest";
import {
  describePluginSettingsError,
  pluginSettingsErrorCode,
  settingsToolReplyText,
} from "../plugin-settings-errors";
import { PluginSettingsRequestError } from "@/shared/plugin-settings";

describe("describePluginSettingsError", () => {
  it.each([
    ["PLUGIN_SETTINGS_OUTPUT_SCHEMA_REQUIRED", /outputSchema/],
    ["PLUGIN_SETTINGS_READ_ARGUMENTS_INVALID", /empty object/],
    ["PLUGIN_SETTINGS_UNSUPPORTED_SCHEMA", /boolean, string/],
    ["PLUGIN_SETTINGS_LIMIT", /512 KB/],
    ["PLUGIN_SETTINGS_TOOL_DENIED", /declined/],
    ["SOMETHING_NEW", /could not be completed/],
    [undefined, /could not be completed/],
  ])("%s", (code, expected) => {
    expect(describePluginSettingsError(code)).toMatch(expected);
  });

  it("never echoes the raw code", () => {
    expect(
      describePluginSettingsError("PLUGIN_SETTINGS_UNSUPPORTED_SCHEMA"),
    ).not.toContain("PLUGIN_SETTINGS");
  });
});

describe("pluginSettingsErrorCode", () => {
  it("reads the code from settings errors only", () => {
    expect(
      pluginSettingsErrorCode(
        new PluginSettingsRequestError("SETTINGS_UNAVAILABLE", true),
      ),
    ).toBe("SETTINGS_UNAVAILABLE");
    expect(pluginSettingsErrorCode(new Error("boom"))).toBeUndefined();
    expect(pluginSettingsErrorCode("nope")).toBeUndefined();
  });
});

describe("settingsToolReplyText", () => {
  it("joins text blocks, collapses whitespace and truncates", () => {
    expect(
      settingsToolReplyText({
        content: [
          { type: "text", text: "Done:\n  reset" },
          { type: "resource_link", uri: "x" },
          { type: "text", text: "<b>ok</b>" },
        ],
      }),
    ).toBe("Done: reset <b>ok</b>");
    const long = settingsToolReplyText({
      content: [{ type: "text", text: "x".repeat(400) }],
    });
    expect(long.length).toBe(160);
    expect(long.endsWith("…")).toBe(true);
    expect(settingsToolReplyText(undefined)).toBe("");
  });
});
