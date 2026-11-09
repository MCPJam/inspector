import { describe, expect, it } from "vitest";
import {
  appendBrowserRefusalContext,
  BROWSER_REFUSAL_MODEL_CONTEXT,
  classifyBrowserRefusal,
  recordBrowserSuppression,
} from "../browser-refusal.js";

const base = {
  configured: true,
  advertised: false,
  suppression: undefined,
  hostedMode: true,
} as const;

describe("classifyBrowserRefusal", () => {
  it.each([
    ["terminal_only", true, "browser_terminal_only"],
    ["hosted_transient", true, "cloud_browser_unavailable"],
    ["hosted_transient", false, "cloud_browser_unavailable"],
    ["hosted_not_configured", true, "cloud_browser_not_configured"],
    ["hosted_not_configured", false, "cloud_browser_unavailable_installation"],
  ] as const)("maps %s (hosted=%s) to %s", (suppression, hostedMode, reason) => {
    expect(
      classifyBrowserRefusal({ ...base, suppression, hostedMode }),
    ).toBe(reason);
  });

  it("stays silent when Browser is off, advertised, or skipped without a code", () => {
    expect(
      classifyBrowserRefusal({
        ...base,
        configured: false,
        suppression: "terminal_only",
      }),
    ).toBeUndefined();
    expect(
      classifyBrowserRefusal({
        ...base,
        advertised: true,
        suppression: "terminal_only",
      }),
    ).toBeUndefined();
    expect(classifyBrowserRefusal(base)).toBeUndefined();
  });
});

describe("appendBrowserRefusalContext", () => {
  it("adds one Browser section and leaves the prompt alone without a reason", () => {
    expect(appendBrowserRefusalContext("Base", undefined)).toBe("Base");
    expect(appendBrowserRefusalContext(undefined, "browser_terminal_only")).toBe(
      `## Browser\n\n${BROWSER_REFUSAL_MODEL_CONTEXT.browser_terminal_only}`,
    );
  });
});

describe("recordBrowserSuppression", () => {
  it("keeps the first coded suppression and ignores uncoded ones", () => {
    const recorder = recordBrowserSuppression();
    recorder.onToolSuppressed({});
    recorder.onToolSuppressed({ code: "hosted_transient" });
    recorder.onToolSuppressed({ code: "terminal_only" });
    expect(recorder.code).toBe("hosted_transient");
  });
});
