import { describe, expect, it } from "vitest";

import { resolveMcpServerIconSrc } from "../mcp-server-icon";

/**
 * A server may ship one icon per theme (MCP `Icon.theme`). Taking `icons[0]`
 * blindly puts a dark-mode mark on a light chat, which is the rendering
 * mismatch BB-136 reports.
 */
describe("resolveMcpServerIconSrc", () => {
  it("picks the icon matching the theme in view", () => {
    const icons = [
      { src: "https://srv.test/light.png", theme: "light" as const },
      { src: "https://srv.test/dark.png", theme: "dark" as const },
    ];

    expect(resolveMcpServerIconSrc(icons, "dark")).toBe(
      "https://srv.test/dark.png",
    );
    expect(resolveMcpServerIconSrc(icons, "light")).toBe(
      "https://srv.test/light.png",
    );
  });

  it("prefers an untagged icon over one meant for the other theme", () => {
    const icons = [
      { src: "https://srv.test/dark.png", theme: "dark" as const },
      { src: "https://srv.test/any.png" },
    ];

    expect(resolveMcpServerIconSrc(icons, "light")).toBe(
      "https://srv.test/any.png",
    );
  });

  it("falls back to the only icon on offer", () => {
    expect(
      resolveMcpServerIconSrc([{ src: "https://srv.test/only.png" }], "dark"),
    ).toBe("https://srv.test/only.png");
  });

  it("returns undefined when the server declares no icon", () => {
    expect(resolveMcpServerIconSrc(undefined, "dark")).toBeUndefined();
    expect(resolveMcpServerIconSrc([], "dark")).toBeUndefined();
  });

  it("ignores an icon with no usable src", () => {
    expect(resolveMcpServerIconSrc([{ src: "" }], "dark")).toBeUndefined();
  });
  it("accepts an inline image data URI", () => {
    const src = "data:image/png;base64,iVBORw0KGgo=";
    expect(resolveMcpServerIconSrc([{ src }], "dark")).toBe(src);
  });

  it("rejects a src the browser should never be pointed at", () => {
    // The icon comes off an MCP server's initialize response, which is
    // untrusted content — same footing as `filterSafeExternalLinkUrls`.
    for (const src of [
      "javascript:alert(1)",
      "vbscript:msgbox(1)",
      "file:///etc/passwd",
      "http://169.254.169.254/latest/meta-data",
      "not a url",
      "data:text/html,<script>alert(1)</script>",
    ]) {
      expect(resolveMcpServerIconSrc([{ src }], "dark")).toBeUndefined();
    }
  });

  it("skips an unsafe icon in favour of a safe one", () => {
    const icons = [
      { src: "javascript:alert(1)", theme: "dark" as const },
      { src: "https://example.test/logo.png" },
    ];
    expect(resolveMcpServerIconSrc(icons, "dark")).toBe(
      "https://example.test/logo.png",
    );
  });

  it("tolerates a server sending something that is not a list", () => {
    expect(
      resolveMcpServerIconSrc(
        { src: "https://example.test/x.png" } as never,
        "dark",
      ),
    ).toBeUndefined();
  });
});
