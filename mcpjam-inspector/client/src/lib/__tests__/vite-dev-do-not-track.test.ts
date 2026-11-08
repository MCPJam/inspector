import { afterEach, describe, expect, it } from "vitest";
import {
  devDoNotTrack,
  devDoNotTrackTags,
} from "../../../vite-dev-do-not-track";
import { getRuntimeDoNotTrack } from "../runtime-config";

afterEach(() => {
  delete window.__MCP_RUNTIME_CONFIG__;
});

describe("the dev server's DO_NOT_TRACK", () => {
  it.each(["1", "true"])(
    "opts the dev document out before the bundle runs, with DO_NOT_TRACK=%s",
    (value) => {
      const [tag, ...rest] = devDoNotTrackTags(value);
      expect(rest).toEqual([]);
      expect(tag).toMatchObject({ tag: "script", injectTo: "head-prepend" });

      // Kept beside whatever runtime config the document already carries.
      window.__MCP_RUNTIME_CONFIG__ = {
        sandboxOrigin: "https://sandbox.example.com",
      };
      new Function(String(tag.children))();
      expect(window.__MCP_RUNTIME_CONFIG__).toEqual({
        sandboxOrigin: "https://sandbox.example.com",
        doNotTrack: true,
      });
      expect(getRuntimeDoNotTrack()).toBe(true);
    },
  );

  it.each([undefined, "", "0", "false", "yes"])(
    "adds nothing with DO_NOT_TRACK=%s",
    (value) => {
      expect(devDoNotTrackTags(value)).toEqual([]);
    },
  );

  it("applies to the dev server only; a build gets the server's runtime config", () => {
    expect(devDoNotTrack("1").apply).toBe("serve");
  });
});
