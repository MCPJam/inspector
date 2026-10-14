import { describe, expect, it } from "vitest";
import { aiRequestHeaders } from "../src/ai-request-headers.js";

describe("AI request attribution", () => {
  it("labels the producer without adding credential headers", () => {
    expect(aiRequestHeaders("sdk-harness", "9.3.1")).toEqual({ "x-mcpjam-client-version": "9.3.1", "x-mcpjam-surface": "sdk-harness" });
    expect(aiRequestHeaders("sdk-stream")["x-mcpjam-client-version"]).toBeTruthy();
  });
});
