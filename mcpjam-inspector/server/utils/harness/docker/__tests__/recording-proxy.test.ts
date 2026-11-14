import { describe, expect, it } from "vitest";
import { harnessProxyForwardUrl, imagesSent } from "./recording-proxy";

describe("harnessProxyForwardUrl", () => {
  const target = "http://127.0.0.1:9/v1";

  it("keeps a path and query on the mock origin", () => {
    expect(harnessProxyForwardUrl(target, "/messages?stream=1").href).toBe(
      "http://127.0.0.1:9/messages?stream=1",
    );
  });

  it("does not follow an absolute or protocol-relative request URL", () => {
    expect(
      harnessProxyForwardUrl(target, "http://example.com/steal").href,
    ).toBe("http://127.0.0.1:9/");
    expect(harnessProxyForwardUrl(target, "//example.com/steal").href).toBe(
      "http://127.0.0.1:9/",
    );
  });
});

describe("imagesSent", () => {
  it("reads Anthropic image blocks and Responses input_image parts", () => {
    expect(
      imagesSent([
        {
          messages: [
            {
              role: "user",
              content: [
                {
                  type: "image",
                  source: { media_type: "image/png", data: "abcd" },
                },
              ],
            },
          ],
        },
        {
          input: [
            {
              role: "user",
              content: [
                {
                  type: "input_image",
                  image_url: "data:image/webp;base64,xyz",
                },
              ],
            },
          ],
        },
      ]),
    ).toEqual(["image/png:4", "image/webp:3"]);
  });
});
