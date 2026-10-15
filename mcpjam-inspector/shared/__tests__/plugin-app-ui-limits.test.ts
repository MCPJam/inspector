import { describe, expect, it } from "vitest";
import {
  PLUGIN_APP_REPLY_MAX_BYTES,
  PLUGIN_APP_UI_MAX_BYTES,
} from "../plugin-app-ui-limits";

const replyBytes = (html: string) =>
  new TextEncoder().encode(JSON.stringify({ html, extra: "x".repeat(1024) }))
    .length;

describe("PLUGIN_APP_REPLY_MAX_BYTES", () => {
  it("fits a max-size UI made of control characters", () => {
    const html = "\u0000".repeat(PLUGIN_APP_UI_MAX_BYTES);
    expect(Buffer.byteLength(html, "utf8")).toBe(PLUGIN_APP_UI_MAX_BYTES);
    expect(replyBytes(html)).toBeLessThanOrEqual(PLUGIN_APP_REPLY_MAX_BYTES);
  });

  it("fits a max-size UI made of lone surrogates", () => {
    const html = "\ud800".repeat(PLUGIN_APP_UI_MAX_BYTES / 3);
    expect(Buffer.byteLength(html, "utf8")).toBeLessThanOrEqual(
      PLUGIN_APP_UI_MAX_BYTES,
    );
    expect(replyBytes(html)).toBeLessThanOrEqual(PLUGIN_APP_REPLY_MAX_BYTES);
  });
});
